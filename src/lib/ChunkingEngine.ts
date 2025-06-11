import { TableSchema } from "./types.js";

export interface ChunkMetadata {
	contentId: string;
	totalChunks: number;
	originalSize: number;
	contentType: 'json' | 'text';
	compressed: boolean;
	encoding?: string;
}

export interface ChunkRecord {
	id?: number;
	content_id: string;
	chunk_index: number;
	chunk_data: string;
	chunk_size: number;
}

export interface GraphQLFieldInfo {
	name: string;
	type: string;
	isList: boolean;
	isNullable: boolean;
	description?: string;
}

export interface GraphQLTypeInfo {
	name: string;
	kind: 'OBJECT' | 'SCALAR' | 'ENUM' | 'INTERFACE';
	fields: Record<string, GraphQLFieldInfo>;
	description?: string;
}

export interface GraphQLSchemaInfo {
	types: Record<string, GraphQLTypeInfo>;
	relationships: Array<{
		fromType: string;
		toType: string;
		fieldName: string;
		cardinality: string;
	}>;
}

export interface FieldChunkingRule {
	fieldName: string;
	typeName: string; // '*' for all types
	chunkThreshold: number;
	priority: 'always' | 'size-based' | 'never';
	reason?: string;
}

/**
 * ChunkingEngine handles storage and retrieval of large content by breaking it into chunks.
 * This improves performance, avoids SQLite size limits, and enables better memory management.
 * 
 * Key features:
 * - Automatic chunking for content over configurable threshold
 * - Optional compression for better storage efficiency
 * - Transparent reassembly during retrieval
 * - Schema-aware chunking strategies
 * - Extensible to any MCP server handling large responses
 */
export class ChunkingEngine {
	private readonly CHUNK_SIZE_THRESHOLD = 32 * 1024; // 32KB - configurable
	private readonly CHUNK_SIZE = 16 * 1024; // 16KB per chunk - optimal for SQLite
	private readonly ENABLE_COMPRESSION = true; // Feature flag for compression
	
	private schemaInfo?: GraphQLSchemaInfo;
	private chunkingRules: FieldChunkingRule[] = [];

	/**
	 * Configure schema-aware chunking
	 */
	configureSchemaAwareness(schemaInfo: GraphQLSchemaInfo): void {
		this.schemaInfo = schemaInfo;
		this.generateChunkingRules();
	}

	/**
	 * Generate intelligent chunking rules based on GraphQL schema
	 */
	private generateChunkingRules(): void {
		if (!this.schemaInfo) return;

		this.chunkingRules = [
			// Never chunk ID fields
			{ fieldName: 'id', typeName: '*', chunkThreshold: Infinity, priority: 'never', reason: 'ID fields should never be chunked' },
			
			// Always chunk known large text fields
			{ fieldName: 'description', typeName: '*', chunkThreshold: 1024, priority: 'always', reason: 'Descriptions are typically large and compressible' },
			{ fieldName: 'summary', typeName: '*', chunkThreshold: 1024, priority: 'always', reason: 'Summaries are typically large and compressible' },
			{ fieldName: 'statement', typeName: '*', chunkThreshold: 2048, priority: 'always', reason: 'Evidence statements can be very long' },
			
			// DGIdb-specific large fields
			{ fieldName: 'interactions', typeName: '*', chunkThreshold: 4096, priority: 'size-based', reason: 'Interaction data can be extensive' },
			{ fieldName: 'sources', typeName: '*', chunkThreshold: 2048, priority: 'size-based', reason: 'Source data can contain large nested objects' },
			
			// Conservative chunking for names and short text
			{ fieldName: 'name', typeName: '*', chunkThreshold: 512, priority: 'size-based', reason: 'Names are usually short but could be long in some cases' },
			{ fieldName: 'displayName', typeName: '*', chunkThreshold: 512, priority: 'size-based', reason: 'Display names are usually short' },
		];

		// Generate type-specific rules based on schema analysis
		for (const [typeName, typeInfo] of Object.entries(this.schemaInfo.types)) {
			if (typeInfo.kind === 'OBJECT') {
				for (const [fieldName, fieldInfo] of Object.entries(typeInfo.fields)) {
					// Large list fields should be chunked aggressively
					if (fieldInfo.isList && this.isLikelyLargeContent(fieldInfo)) {
						this.chunkingRules.push({
							fieldName,
							typeName,
							chunkThreshold: 8192,
							priority: 'size-based',
							reason: `List field ${fieldName} on ${typeName} likely contains large content`
						});
					}
				}
			}
		}
	}

	/**
	 * Determine if a field is likely to contain large content based on schema info
	 */
	private isLikelyLargeContent(fieldInfo: GraphQLFieldInfo): boolean {
		const largeContentIndicators = [
			'description', 'summary', 'statement', 'content', 'text', 'body',
			'metadata', 'details', 'comments', 'notes', 'evidence', 'interactions'
		];
		
		return largeContentIndicators.some(indicator => 
			fieldInfo.name.toLowerCase().includes(indicator) ||
			fieldInfo.description?.toLowerCase().includes(indicator)
		);
	}

	/**
	 * Schema-aware JSON stringification with intelligent chunking decisions
	 */
	async schemaAwareJsonStringify(
		obj: any, 
		typeName: string, 
		fieldName: string, 
		sql: any
	): Promise<string> {
		const jsonString = JSON.stringify(obj);
		
		// Check schema-based chunking rules first
		const applicableRule = this.getApplicableChunkingRule(fieldName, typeName);
		
		if (applicableRule) {
			if (applicableRule.priority === 'never') {
				return jsonString;
			} else if (applicableRule.priority === 'always' && jsonString.length > applicableRule.chunkThreshold) {
				const metadata = await this.storeChunkedContent(jsonString, 'json', sql);
				return this.createContentReference(metadata);
			} else if (applicableRule.priority === 'size-based' && jsonString.length > applicableRule.chunkThreshold) {
				const metadata = await this.storeChunkedContent(jsonString, 'json', sql);
				return this.createContentReference(metadata);
			}
		}
		
		// Fallback to default behavior
		if (!this.shouldChunk(jsonString)) {
			return jsonString;
		}

		const metadata = await this.storeChunkedContent(jsonString, 'json', sql);
		return this.createContentReference(metadata);
	}

	/**
	 * Get the most specific chunking rule for a field
	 */
	private getApplicableChunkingRule(fieldName: string, typeName: string): FieldChunkingRule | null {
		// Try exact type match first
		let rule = this.chunkingRules.find(r => r.fieldName === fieldName && r.typeName === typeName);
		if (rule) return rule;
		
		// Try wildcard type match
		rule = this.chunkingRules.find(r => r.fieldName === fieldName && r.typeName === '*');
		if (rule) return rule;
		
		return null;
	}

	/**
	 * Analyze chunking effectiveness and provide recommendations
	 */
	async analyzeChunkingEffectiveness(sql: any): Promise<any> {
		const stats = await this.getChunkingStats(sql);
		
		if (!this.schemaInfo) {
			return {
				...stats,
				recommendation: "Enable schema-aware chunking for better optimization",
				schema_awareness: false
			};
		}

		// Analyze which fields are being chunked most
		const fieldAnalysis = await this.analyzeChunkedFields(sql);
		
		return {
			...stats,
			schema_awareness: true,
			field_analysis: fieldAnalysis,
			recommendations: this.generateChunkingRecommendations(fieldAnalysis)
		};
	}

	private async analyzeChunkedFields(sql: any): Promise<any> {
		// This would analyze the chunk_metadata to see which types of content
		// are being chunked most frequently and suggest optimizations
		
		try {
			const result = sql.exec(`
				SELECT 
					content_type,
					original_size,
					compressed,
					COUNT(*) as chunk_count
				FROM chunk_metadata 
				GROUP BY content_type, compressed
				ORDER BY chunk_count DESC
			`).toArray();
			
			return result;
		} catch (error) {
			return { error: "Could not analyze chunked fields" };
		}
	}

	private generateChunkingRecommendations(fieldAnalysis: any): string[] {
		const recommendations = [];
		
		if (this.chunkingRules.length === 0) {
			recommendations.push("Configure field-specific chunking rules based on your GraphQL schema");
		}
		
		if (fieldAnalysis && fieldAnalysis.length > 0) {
			const uncompressedCount = fieldAnalysis.filter((f: any) => !f.compressed).length;
			if (uncompressedCount > 0) {
				recommendations.push("Enable compression for better storage efficiency");
			}
		}
		
		recommendations.push("Monitor chunk size distribution and adjust thresholds based on query patterns");
		
		return recommendations;
	}

	/**
	 * Determines if content should be chunked based on size threshold
	 */
	shouldChunk(content: string): boolean {
		return content.length > this.CHUNK_SIZE_THRESHOLD;
	}

	/**
	 * Stores large content as chunks, returns metadata for retrieval
	 */
	async storeChunkedContent(
		content: string, 
		contentType: 'json' | 'text',
		sql: any
	): Promise<ChunkMetadata> {
		const contentId = this.generateContentId();
		let processedContent = content;
		let compressed = false;

		// Optional compression (when available in environment)
		if (this.ENABLE_COMPRESSION && this.shouldCompress(content)) {
			try {
				processedContent = await this.compress(content);
				compressed = true;
			} catch (error) {
				console.warn('Compression failed, storing uncompressed:', error);
				processedContent = content;
			}
		}

		// Ensure chunks table exists
		await this.ensureChunksTable(sql);

		// Split into chunks
		const chunks = this.splitIntoChunks(processedContent);
		
		// Store each chunk
		for (let i = 0; i < chunks.length; i++) {
			const chunkRecord: ChunkRecord = {
				content_id: contentId,
				chunk_index: i,
				chunk_data: chunks[i],
				chunk_size: chunks[i].length
			};
			
			await this.insertChunk(chunkRecord, sql);
		}

		// Store metadata
		const metadata: ChunkMetadata = {
			contentId,
			totalChunks: chunks.length,
			originalSize: content.length,
			contentType,
			compressed,
			encoding: compressed ? 'gzip' : undefined
		};

		await this.storeMetadata(metadata, sql);
		
		return metadata;
	}

	/**
	 * Retrieves and reassembles chunked content
	 */
	async retrieveChunkedContent(contentId: string, sql: any): Promise<string | null> {
		try {
			// Get metadata
			const metadata = await this.getMetadata(contentId, sql);
			if (!metadata) return null;

			// Retrieve all chunks in order
			const chunks = await this.getChunks(contentId, metadata.totalChunks, sql);
			if (chunks.length !== metadata.totalChunks) {
				throw new Error(`Missing chunks: expected ${metadata.totalChunks}, found ${chunks.length}`);
			}

			// Reassemble content
			const reassembled = chunks.join('');

			// Decompress if needed
			if (metadata.compressed) {
				try {
					return await this.decompress(reassembled);
				} catch (error) {
					console.error('Decompression failed:', error);
					throw new Error('Failed to decompress content');
				}
			}

			return reassembled;
		} catch (error) {
			console.error(`Failed to retrieve chunked content ${contentId}:`, error);
			return null;
		}
	}

	/**
	 * Creates a content reference for schema columns instead of storing large content directly
	 */
	createContentReference(metadata: ChunkMetadata): string {
		return `__CHUNKED__:${metadata.contentId}`;
	}

	/**
	 * Checks if a value is a chunked content reference
	 */
	isContentReference(value: any): boolean {
		return typeof value === 'string' && value.startsWith('__CHUNKED__:');
	}

	/**
	 * Extracts content ID from a content reference
	 */
	extractContentId(reference: string): string {
		return reference.replace('__CHUNKED__:', '');
	}

	/**
	 * Enhanced JSON stringification with automatic chunking
	 */
	async smartJsonStringify(obj: any, sql: any): Promise<string> {
		const jsonString = JSON.stringify(obj);
		
		if (!this.shouldChunk(jsonString)) {
			return jsonString;
		}

		// Store as chunks and return reference
		const metadata = await this.storeChunkedContent(jsonString, 'json', sql);
		return this.createContentReference(metadata);
	}

	/**
	 * Enhanced JSON parsing with automatic chunk retrieval
	 */
	async smartJsonParse(value: string, sql: any): Promise<any> {
		if (!this.isContentReference(value)) {
			return JSON.parse(value);
		}

		const contentId = this.extractContentId(value);
		const retrievedContent = await this.retrieveChunkedContent(contentId, sql);
		
		if (!retrievedContent) {
			throw new Error(`Failed to retrieve chunked content: ${contentId}`);
		}

		return JSON.parse(retrievedContent);
	}

	/**
	 * Cleanup chunked content (for maintenance)
	 */
	async cleanupChunkedContent(contentId: string, sql: any): Promise<void> {
		try {
			// Delete chunks
			sql.exec(
				`DELETE FROM content_chunks WHERE content_id = ?`,
				contentId
			);

			// Delete metadata
			sql.exec(
				`DELETE FROM chunk_metadata WHERE content_id = ?`,
				contentId
			);
		} catch (error) {
			console.error(`Failed to cleanup chunked content ${contentId}:`, error);
		}
	}

	/**
	 * Get statistics about chunked content storage
	 */
	async getChunkingStats(sql: any): Promise<any> {
		try {
			const metadataResult = sql.exec(`
				SELECT 
					COUNT(*) as total_chunked_items,
					SUM(original_size) as total_original_size,
					AVG(original_size) as avg_original_size,
					SUM(total_chunks) as total_chunks,
					COUNT(CASE WHEN compressed = 1 THEN 1 END) as compressed_items
				FROM chunk_metadata
			`).one();

			const chunksResult = sql.exec(`
				SELECT 
					COUNT(*) as total_chunk_records,
					SUM(chunk_size) as total_stored_size,
					AVG(chunk_size) as avg_chunk_size
				FROM content_chunks
			`).one();

			return {
				metadata: metadataResult || {},
				chunks: chunksResult || {},
				compression_ratio: metadataResult?.total_original_size && chunksResult?.total_stored_size 
					? (metadataResult.total_original_size / chunksResult.total_stored_size).toFixed(2)
					: null
			};
		} catch (error) {
			return { error: error instanceof Error ? error.message : 'Failed to get stats' };
		}
	}

	// Private helper methods

	private generateContentId(): string {
		return 'chunk_' + crypto.randomUUID().replace(/-/g, '');
	}

	private shouldCompress(content: string): boolean {
		// Compress content larger than 8KB (good compression threshold)
		return content.length > 8192;
	}

	private async compress(content: string): Promise<string> {
		// In a real implementation, you might use compression libraries
		// For now, we'll use a simple base64 encoding as a placeholder
		// In production, consider using gzip/deflate when available
		try {
			const uint8Array = new TextEncoder().encode(content);
			
			// Check if CompressionStream is available (modern browsers/runtimes)
			if (typeof CompressionStream !== 'undefined') {
				const compressionStream = new CompressionStream('gzip');
				const writer = compressionStream.writable.getWriter();
				const reader = compressionStream.readable.getReader();
				
				writer.write(uint8Array);
				writer.close();
				
				const chunks: Uint8Array[] = [];
				let result = await reader.read();
				while (!result.done) {
					chunks.push(result.value);
					result = await reader.read();
				}
				
				// Combine chunks and encode to base64
				const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
				const combined = new Uint8Array(totalLength);
				let offset = 0;
				for (const chunk of chunks) {
					combined.set(chunk, offset);
					offset += chunk.length;
				}
				
				return btoa(String.fromCharCode(...combined));
			}
			
			// Fallback to simple base64 encoding (not real compression)
			return btoa(content);
		} catch (error) {
			throw new Error(`Compression failed: ${error}`);
		}
	}

	private async decompress(compressedContent: string): Promise<string> {
		try {
			// Check if DecompressionStream is available
			if (typeof DecompressionStream !== 'undefined') {
				const compressedData = Uint8Array.from(atob(compressedContent), c => c.charCodeAt(0));
				
				const decompressionStream = new DecompressionStream('gzip');
				const writer = decompressionStream.writable.getWriter();
				const reader = decompressionStream.readable.getReader();
				
				writer.write(compressedData);
				writer.close();
				
				const chunks: Uint8Array[] = [];
				let result = await reader.read();
				while (!result.done) {
					chunks.push(result.value);
					result = await reader.read();
				}
				
				const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
				const combined = new Uint8Array(totalLength);
				let offset = 0;
				for (const chunk of chunks) {
					combined.set(chunk, offset);
					offset += chunk.length;
				}
				
				return new TextDecoder().decode(combined);
			}
			
			// Fallback from base64
			return atob(compressedContent);
		} catch (error) {
			throw new Error(`Decompression failed: ${error}`);
		}
	}

	private splitIntoChunks(content: string): string[] {
		const chunks: string[] = [];
		for (let i = 0; i < content.length; i += this.CHUNK_SIZE) {
			chunks.push(content.slice(i, i + this.CHUNK_SIZE));
		}
		return chunks;
	}

	private async ensureChunksTable(sql: any): Promise<void> {
		// Create chunks table
		sql.exec(`
			CREATE TABLE IF NOT EXISTS content_chunks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				content_id TEXT NOT NULL,
				chunk_index INTEGER NOT NULL,
				chunk_data TEXT NOT NULL,
				chunk_size INTEGER NOT NULL,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(content_id, chunk_index)
			)
		`);

		// Create metadata table
		sql.exec(`
			CREATE TABLE IF NOT EXISTS chunk_metadata (
				content_id TEXT PRIMARY KEY,
				total_chunks INTEGER NOT NULL,
				original_size INTEGER NOT NULL,
				content_type TEXT NOT NULL,
				compressed INTEGER DEFAULT 0,
				encoding TEXT,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP
			)
		`);

		// Create indexes for performance
		sql.exec(`CREATE INDEX IF NOT EXISTS idx_content_chunks_lookup ON content_chunks(content_id, chunk_index)`);
		sql.exec(`CREATE INDEX IF NOT EXISTS idx_chunk_metadata_size ON chunk_metadata(original_size)`);
	}

	private async insertChunk(chunk: ChunkRecord, sql: any): Promise<void> {
		sql.exec(
			`INSERT INTO content_chunks (content_id, chunk_index, chunk_data, chunk_size) 
			 VALUES (?, ?, ?, ?)`,
			chunk.content_id,
			chunk.chunk_index, 
			chunk.chunk_data,
			chunk.chunk_size
		);
	}

	private async storeMetadata(metadata: ChunkMetadata, sql: any): Promise<void> {
		sql.exec(
			`INSERT INTO chunk_metadata (content_id, total_chunks, original_size, content_type, compressed, encoding)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			metadata.contentId,
			metadata.totalChunks,
			metadata.originalSize,
			metadata.contentType,
			metadata.compressed ? 1 : 0,
			metadata.encoding || null
		);
	}

	private async getMetadata(contentId: string, sql: any): Promise<ChunkMetadata | null> {
		const result = sql.exec(
			`SELECT * FROM chunk_metadata WHERE content_id = ?`,
			contentId
		).one();

		if (!result) return null;

		return {
			contentId: result.content_id,
			totalChunks: result.total_chunks,
			originalSize: result.original_size,
			contentType: result.content_type,
			compressed: Boolean(result.compressed),
			encoding: result.encoding
		};
	}

	private async getChunks(contentId: string, expectedCount: number, sql: any): Promise<string[]> {
		const results = sql.exec(
			`SELECT chunk_data FROM content_chunks 
			 WHERE content_id = ? 
			 ORDER BY chunk_index ASC`,
			contentId
		).toArray();

		return results.map((row: any) => row.chunk_data);
	}
} 