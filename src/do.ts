import { DurableObject } from "cloudflare:workers";

import { SchemaInferenceEngine } from "./lib/SchemaInferenceEngine.js";
import { DataInsertionEngine } from "./lib/DataInsertionEngine.js";
import { PaginationAnalyzer } from "./lib/PaginationAnalyzer.js";
import { ChunkingEngine } from "./lib/ChunkingEngine.js";
import { TableSchema, ProcessingResult, PaginationInfo } from "./lib/types.js";


// Main Durable Object class - clean and focused
export class JsonToSqlDO extends DurableObject {
	private chunkingEngine = new ChunkingEngine();

	constructor(ctx: DurableObjectState, env: any) {
		super(ctx, env);
	}

	async processAndStoreJson(jsonData: any): Promise<ProcessingResult> {
		try {
			let dataToProcess = jsonData?.data ? jsonData.data : jsonData;
			const paginationInfo = PaginationAnalyzer.extractInfo(dataToProcess); // Analyze from overall data structure

			const schemaEngine = new SchemaInferenceEngine();
			const schemas = schemaEngine.inferFromJSON(dataToProcess);
			
			// Create tables
			await this.createTables(schemas);
			
			// Insert data
			const dataInsertionEngine = new DataInsertionEngine();
			await dataInsertionEngine.insertData(dataToProcess, schemas, this.ctx.storage.sql);
			
			// Generate metadata
			const metadata = await this.generateMetadata(schemas);
			
			// Add pagination if available
			if (paginationInfo.hasNextPage) {
				metadata.pagination = paginationInfo;
			}
			
			return {
				success: true,
				message: "Data processed successfully",
				...metadata
			};
			
		} catch (error) {
			return {
				success: false,
				message: error instanceof Error ? error.message : "Processing failed"
			};
		}
	}

	async executeSql(sqlQuery: string): Promise<any> {
		try {
			// Enhanced security validation for analytical SQL
			const validationResult = this.validateAnalyticalSql(sqlQuery);
			if (!validationResult.isValid) {
				throw new Error(validationResult.error);
			}

			const result = this.ctx.storage.sql.exec(sqlQuery);
			const results = result.toArray();

			return {
				success: true,
				results,
				row_count: results.length,
				column_names: result.columnNames || [],
				query_type: validationResult.queryType
			};

		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "SQL execution failed",
				query: sqlQuery
			};
		}
	}

	/**
	 * Enhanced SQL execution with automatic chunked content resolution
	 */
	async executeEnhancedSql(sqlQuery: string): Promise<any> {
		try {
			// First execute the regular SQL
			const result = await this.executeSql(sqlQuery);
			
			if (!result.success) {
				return result;
			}

			// Process results to resolve any chunked content references
			const enhancedResults = await this.resolveChunkedContentInResults(result.results);

			return {
				...result,
				results: enhancedResults,
				chunked_content_resolved: enhancedResults.length !== result.results.length || 
					JSON.stringify(enhancedResults) !== JSON.stringify(result.results)
			};

		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Enhanced SQL execution failed",
				query: sqlQuery
			};
		}
	}

	/**
	 * Resolves chunked content references in SQL results
	 */
	private async resolveChunkedContentInResults(results: any[]): Promise<any[]> {
		const resolvedResults = [];

		for (const row of results) {
			const resolvedRow: any = {};
			
			for (const [key, value] of Object.entries(row)) {
				if (this.chunkingEngine.isContentReference(value)) {
					try {
						const contentId = this.chunkingEngine.extractContentId(value as string);
						const resolvedContent = await this.chunkingEngine.retrieveChunkedContent(
							contentId, 
							this.ctx.storage.sql
						);
						
						if (resolvedContent !== null) {
							// Try to parse as JSON if it looks like JSON
							try {
								resolvedRow[key] = JSON.parse(resolvedContent);
							} catch {
								// If not valid JSON, return as string
								resolvedRow[key] = resolvedContent;
							}
						} else {
							resolvedRow[key] = `[CHUNKED_CONTENT_NOT_FOUND:${contentId}]`;
						}
					} catch (error) {
						console.error(`Failed to resolve chunked content for ${key}:`, error);
						resolvedRow[key] = `[CHUNKED_CONTENT_ERROR:${error}]`;
					}
				} else {
					resolvedRow[key] = value;
				}
			}
			
			resolvedResults.push(resolvedRow);
		}

		return resolvedResults;
	}

	/**
	 * Initialize basic chunking (schema-aware chunking not available for DGIdb)
	 */
	async initializeSchemaAwareChunking(schemaContent: string): Promise<any> {
		return {
			success: false,
			error: "Schema-aware chunking not available for DGIdb implementation",
			message: "DGIdb MCP server uses fallback chunking based on content size",
			alternatives: [
				"Use the basic chunking that's automatically enabled",
				"Large content (>32KB) is automatically chunked",
				"Monitor chunking effectiveness with /chunking-stats endpoint"
			]
		};
	}

	private validateAnalyticalSql(sql: string): {isValid: boolean, error?: string, queryType?: string} {
		const trimmedSql = sql.trim().toLowerCase();
		
		// Allowed operations for analytical work
		const allowedStarters = [
			'select',
			'with',           // CTEs for complex analysis
			'pragma',         // Schema inspection
			'explain',        // Query planning
			'create temporary table',
			'create temp table',
			'create view',
			'create temporary view',
			'create temp view',
			'drop view',      // Clean up session views
			'drop temporary table',
			'drop temp table'
		];

		// Dangerous operations that modify permanent data
		const blockedPatterns = [
			/\bdrop\s+table\s+(?!temp|temporary)/i,    // Block permanent table drops
			/\bdelete\s+from/i,                        // Block data deletion
			/\bupdate\s+\w+\s+set/i,                   // Block data updates
			/\binsert\s+into\s+(?!temp|temporary)/i,   // Block permanent inserts
			/\balter\s+table/i,                        // Block schema changes
			/\bcreate\s+table\s+(?!temp|temporary)/i,  // Block permanent table creation
			/\battach\s+database/i,                    // Block external database access
			/\bdetach\s+database/i                     // Block database detachment
		];

		// Check if query starts with allowed operation
		const startsWithAllowed = allowedStarters.some(starter => 
			trimmedSql.startsWith(starter)
		);

		if (!startsWithAllowed) {
			return {
				isValid: false, 
				error: `Query type not allowed. Permitted operations: ${allowedStarters.join(', ')}`
			};
		}

		// Check for blocked patterns
		for (const pattern of blockedPatterns) {
			if (pattern.test(sql)) {
				return {
					isValid: false,
					error: `Operation blocked for security: ${pattern.source}`
				};
			}
		}

		// Determine query type for response metadata
		let queryType = 'select';
		if (trimmedSql.startsWith('with')) queryType = 'cte';
		else if (trimmedSql.startsWith('pragma')) queryType = 'pragma';
		else if (trimmedSql.startsWith('explain')) queryType = 'explain';
		else if (trimmedSql.includes('create')) queryType = 'create_temp';

		return {isValid: true, queryType};
	}

	private async createTables(schemas: Record<string, TableSchema>): Promise<void> {
		for (const [tableName, schema] of Object.entries(schemas)) {
			try {
				// Validate table name
				const validTableName = this.validateAndFixIdentifier(tableName, 'table');
				
				// Validate and fix column definitions
				const validColumnDefs: string[] = [];
				for (const [name, type] of Object.entries(schema.columns)) {
					const validColumnName = this.validateAndFixIdentifier(name, 'column');
					const validType = this.validateSQLiteType(String(type));
					validColumnDefs.push(`${validColumnName} ${validType}`);
				}

				if (validColumnDefs.length === 0) {
					console.warn(`Skipping table ${tableName} - no valid columns`);
					continue;
				}

				const createTableSQL = `CREATE TABLE IF NOT EXISTS ${validTableName} (${validColumnDefs.join(', ')})`;
				
				// Add logging for debugging
				console.log(`Creating table with SQL: ${createTableSQL}`);
				
				this.ctx.storage.sql.exec(createTableSQL);
			} catch (error) {
				console.error(`Error creating table ${tableName}:`, error);
				// Try to create a fallback table with safe defaults
				try {
					const fallbackTableName = this.validateAndFixIdentifier(tableName, 'table');
					const fallbackSQL = `CREATE TABLE IF NOT EXISTS ${fallbackTableName} (id INTEGER PRIMARY KEY AUTOINCREMENT, data_json TEXT)`;
					this.ctx.storage.sql.exec(fallbackSQL);
				} catch (fallbackError) {
					console.error(`Failed to create fallback table for ${tableName}:`, fallbackError);
					// Skip this table entirely
				}
			}
		}
	}

	private validateAndFixIdentifier(name: string, type: 'table' | 'column'): string {
		if (!name || typeof name !== 'string') {
			return type === 'table' ? 'fallback_table' : 'fallback_column';
		}

		// Remove or replace problematic characters
		let fixed = name
			.replace(/[^a-zA-Z0-9_]/g, '_')
			.replace(/_{2,}/g, '_')
			.replace(/^_|_$/g, '');

		// Ensure it doesn't start with a number
		if (/^[0-9]/.test(fixed)) {
			fixed = (type === 'table' ? 'table_' : 'col_') + fixed;
		}

		// Ensure it's not empty
		if (!fixed || fixed.length === 0) {
			fixed = type === 'table' ? 'fallback_table' : 'fallback_column';
		}

		// Handle SQL reserved words by adding suffix
		const reservedWords = [
			'table', 'index', 'view', 'column', 'primary', 'key', 'foreign', 'constraint',
			'order', 'group', 'select', 'from', 'where', 'insert', 'update', 'delete',
			'create', 'drop', 'alter', 'join', 'inner', 'outer', 'left', 'right',
			'union', 'all', 'distinct', 'having', 'limit', 'offset', 'as', 'on'
		];
		
		if (reservedWords.includes(fixed.toLowerCase())) {
			fixed = fixed + (type === 'table' ? '_tbl' : '_col');
		}

		return fixed.toLowerCase();
	}

	private validateSQLiteType(type: string): string {
		if (!type || typeof type !== 'string') {
			return 'TEXT';
		}

		const upperType = type.toUpperCase();
		
		// Map common types to valid SQLite types
		const validTypes = [
			'INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC',
			'INTEGER PRIMARY KEY', 'INTEGER PRIMARY KEY AUTOINCREMENT',
			'JSON'  // SQLite supports JSON since 3.38
		];

		// Check if it's already a valid type
		if (validTypes.some(validType => upperType.includes(validType))) {
			return type;
		}

		// Map common type variations
		const typeMap: Record<string, string> = {
			'STRING': 'TEXT',
			'VARCHAR': 'TEXT',
			'CHAR': 'TEXT',
			'CLOB': 'TEXT',
			'INT': 'INTEGER',
			'BIGINT': 'INTEGER',
			'SMALLINT': 'INTEGER',
			'TINYINT': 'INTEGER',
			'FLOAT': 'REAL',
			'DOUBLE': 'REAL',
			'DECIMAL': 'NUMERIC',
			'BOOLEAN': 'INTEGER',
			'BOOL': 'INTEGER',
			'DATE': 'TEXT',
			'DATETIME': 'TEXT',
			'TIMESTAMP': 'TEXT'
		};

		return typeMap[upperType] || 'TEXT';
	}

	private async generateMetadata(schemas: Record<string, TableSchema>): Promise<Partial<ProcessingResult>> {
		const metadata: Partial<ProcessingResult> = {
			schemas: {},
			table_count: Object.keys(schemas).length,
			total_rows: 0
		};

		for (const [tableName, schema] of Object.entries(schemas)) {
			try {
				// Validate table name before querying
				const validatedTableName = this.validateAndFixIdentifier(tableName, 'table');
				
				// Use safer query execution with proper error handling
				const countResult = this.ctx.storage.sql.exec(`SELECT COUNT(*) as count FROM ${validatedTableName}`);
				const countRows = countResult.toArray();
				
				let rowCount = 0;
				if (countRows.length === 1) {
					const countRow = countRows[0];
					rowCount = typeof countRow?.count === 'number' ? countRow.count : 0;
				}

				const sampleResult = this.ctx.storage.sql.exec(`SELECT * FROM ${validatedTableName} LIMIT 3`);
				const sampleData = sampleResult.toArray();

				metadata.schemas![tableName] = {
					columns: schema.columns,
					row_count: rowCount,
					sample_data: sampleData
				};

				metadata.total_rows! += rowCount;

			} catch (error) {
				// Log the specific error for debugging but continue with other tables
				console.warn(`Error processing table ${tableName}:`, error);
				// Add fallback metadata for this table
				metadata.schemas![tableName] = {
					columns: schema.columns,
					row_count: 0,
					sample_data: []
				};
			}
		}

		return metadata;
	}

	async getSchemaInfo(): Promise<any> {
		try {
			const tables = this.ctx.storage.sql.exec(`
				SELECT name, type 
				FROM sqlite_master 
				WHERE type IN ('table', 'view') 
				ORDER BY name
			`).toArray();

			const schemaInfo: any = {
				database_summary: {
					total_tables: tables.length,
					table_names: tables.map(t => String(t.name))
				},
				tables: {}
			};

			for (const table of tables) {
				const tableName = String(table.name);
				if (!tableName || tableName === 'undefined' || tableName === 'null') {
					continue; // Skip invalid table names
				}
				
				try {
					// Get column information
					const columns = this.ctx.storage.sql.exec(`PRAGMA table_info(${tableName})`).toArray();
					
					// Get row count with safer error handling
					const countResult = this.ctx.storage.sql.exec(`SELECT COUNT(*) as count FROM ${tableName}`);
					const countRows = countResult.toArray();
					
					let rowCount = 0;
					if (countRows.length === 1) {
						const countRow = countRows[0];
						rowCount = typeof countRow?.count === 'number' ? countRow.count : 0;
					}
					
					// Get sample data (first 3 rows)
					const sampleData = this.ctx.storage.sql.exec(`SELECT * FROM ${tableName} LIMIT 3`).toArray();
					
					// Get foreign key information
					const foreignKeys = this.ctx.storage.sql.exec(`PRAGMA foreign_key_list(${tableName})`).toArray();
					
					// Get indexes
					const indexes = this.ctx.storage.sql.exec(`PRAGMA index_list(${tableName})`).toArray();

					schemaInfo.tables[tableName] = {
						type: String(table.type),
						row_count: rowCount,
						columns: columns.map((col: any) => ({
							name: String(col.name),
							type: String(col.type),
							not_null: Boolean(col.notnull),
							default_value: col.dflt_value,
							primary_key: Boolean(col.pk)
						})),
						foreign_keys: foreignKeys.map((fk: any) => ({
							column: String(fk.from),
							references_table: String(fk.table),
							references_column: String(fk.to)
						})),
						indexes: indexes.map((idx: any) => ({
							name: String(idx.name),
							unique: Boolean(idx.unique)
						})),
						sample_data: sampleData
					};
				} catch (tableError) {
					// Skip this table if there's an error processing it
					console.error(`Error processing table ${tableName}:`, tableError);
					continue;
				}
			}

			return {
				success: true,
				schema_info: schemaInfo
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Schema inspection failed"
			};
		}
	}

	async getTableColumns(tableName: string): Promise<any> {
		try {
			const columns = this.ctx.storage.sql.exec(`PRAGMA table_info(${tableName})`).toArray();
			const foreignKeys = this.ctx.storage.sql.exec(`PRAGMA foreign_key_list(${tableName})`).toArray();
			
			return {
				success: true,
				table: tableName,
				columns: columns.map((col: any) => {
					const fkRef = foreignKeys.find((fk: any) => fk.from === col.name);
					return {
						name: col.name,
						type: col.type,
						not_null: Boolean(col.notnull),
						default_value: col.dflt_value,
						primary_key: Boolean(col.pk),
						is_foreign_key: Boolean(fkRef),
						references: fkRef ? {
							table: fkRef.table,
							column: fkRef.to
						} : null
					};
				})
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Table inspection failed"
			};
		}
	}

	async generateAnalyticalQueries(tableName?: string): Promise<any> {
		try {
			const suggestions: any = {
				schema_discovery: [
					"PRAGMA table_list",
					"SELECT name FROM sqlite_master WHERE type='table'",
					tableName ? `PRAGMA table_info(${tableName})` : "-- Specify table name for column info"
				],
				json_analysis: [
					"-- SQLite JSON functions for analyzing JSON columns:",
					"SELECT json_extract(column_name, '$.field') FROM table_name",
					"SELECT json_array_length(column_name) FROM table_name WHERE column_name IS NOT NULL",
					"SELECT json_each.value FROM table_name, json_each(table_name.column_name)"
				],
				statistical_analysis: [
					"-- Basic statistics:",
					"SELECT COUNT(*), AVG(numeric_column), MIN(numeric_column), MAX(numeric_column) FROM table_name",
					"-- Distribution analysis:",
					"SELECT column_name, COUNT(*) as frequency FROM table_name GROUP BY column_name ORDER BY frequency DESC",
					"-- Cross-table analysis with CTEs:",
					"WITH summary AS (SELECT ...) SELECT * FROM summary WHERE ..."
				],
				dgidb_specific: [
					"-- Drug-gene interactions by source:",
					"SELECT source_db_name, COUNT(*) as interaction_count FROM interactions GROUP BY source_db_name",
					"-- Gene categories distribution:",
					"SELECT category, COUNT(*) FROM genes GROUP BY category",
					"-- Top drugs by interaction count:",
					"SELECT drug_name, COUNT(*) as gene_count FROM interactions GROUP BY drug_name ORDER BY gene_count DESC LIMIT 10"
				]
			};

			return {
				success: true,
				query_suggestions: suggestions
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Query generation failed"
			};
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		try {
			if (url.pathname === '/process' && request.method === 'POST') {
				const jsonData = await request.json();
				const result = await this.processAndStoreJson(jsonData);
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/query' && request.method === 'POST') {
				const { sql } = await request.json() as { sql: string };
				const result = await this.executeSql(sql);
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/schema' && request.method === 'GET') {
				const result = await this.getSchemaInfo();
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/table-info' && request.method === 'POST') {
				const { table_name } = await request.json() as { table_name: string };
				const result = await this.getTableColumns(table_name);
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/query-suggestions' && request.method === 'GET') {
				const tableName = url.searchParams.get('table');
				const result = await this.generateAnalyticalQueries(tableName || undefined);
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/query-enhanced' && request.method === 'POST') {
				const { sql } = await request.json() as { sql: string };
				const result = await this.executeEnhancedSql(sql);
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/chunking-stats' && request.method === 'GET') {
				const result = await this.chunkingEngine.getChunkingStats(this.ctx.storage.sql);
				return new Response(JSON.stringify({
					success: true,
					chunking_statistics: result
				}), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/initialize-schema' && request.method === 'POST') {
				const { schemaContent } = await request.json() as { schemaContent: string };
				const result = await this.initializeSchemaAwareChunking(schemaContent);
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/chunking-analysis' && request.method === 'GET') {
				const result = await this.chunkingEngine.analyzeChunkingEffectiveness(this.ctx.storage.sql);
				return new Response(JSON.stringify({
					success: true,
					analysis: result
				}), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/delete' && request.method === 'DELETE') {
				await this.ctx.storage.deleteAll();
				return new Response(JSON.stringify({ success: true }), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else {
				return new Response('Not Found', { status: 404 });
			}
		} catch (error) {
			return new Response(JSON.stringify({
				error: error instanceof Error ? error.message : 'Unknown error'
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}
} 