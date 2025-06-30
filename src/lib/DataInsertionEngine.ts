import { TableSchema } from "./types.js";
import { ChunkingEngine } from "./ChunkingEngine.js";

export class DataInsertionEngine {
	private chunkingEngine = new ChunkingEngine();
	private processedEntities: Map<string, Map<any, number | string>> = new Map();
	private relationshipData: Map<string, Set<string>> = new Map(); // Track actual relationships found in data

	async insertData(data: any, schemas: Record<string, TableSchema>, sql: any): Promise<void> {
		// Reset state for new insertion
		this.processedEntities.clear();
		this.relationshipData.clear();

		const schemaNames = Object.keys(schemas);

		// Check if this is one of the simple fallback schemas
		if (schemaNames.length === 1 && (schemaNames[0] === 'scalar_data' || schemaNames[0] === 'array_data' || schemaNames[0] === 'root_object')) {
			const tableName = schemaNames[0];
			const schema = schemas[tableName];
			if (tableName === 'scalar_data' || tableName === 'root_object') {
				await this.insertSimpleRow(data, tableName, schema, sql);
			} else { // array_data
				if (Array.isArray(data)) {
					for (const item of data) {
						await this.insertSimpleRow(item, tableName, schema, sql);
					}
				} else {
					await this.insertSimpleRow(data, tableName, schema, sql); 
				}
			}
			return;
		}

		// Phase 1: Insert all entities first (to establish primary keys)
		await this.insertAllEntities(data, schemas, sql);
		
		// Phase 2: Handle relationships via junction tables (only for tables with data)
		await this.insertJunctionTableRecords(data, schemas, sql);
	}

	private async insertAllEntities(obj: any, schemas: Record<string, TableSchema>, sql: any, path: string[] = []): Promise<void> {
		if (!obj || typeof obj !== 'object') return;
		
		// Handle arrays of entities
		if (Array.isArray(obj)) {
			for (const item of obj) {
				await this.insertAllEntities(item, schemas, sql, path);
			}
			return;
		}
		
		// Handle GraphQL edges pattern
		if (obj.edges && Array.isArray(obj.edges)) {
			const nodes = obj.edges.map((edge: any) => edge.node).filter(Boolean);
			for (const node of nodes) {
				await this.insertAllEntities(node, schemas, sql, path);
			}
			return;
		}
		
		// Handle individual entities
		if (this.isEntity(obj)) {
			const entityType = this.inferEntityType(obj, path);
			if (schemas[entityType]) {
				await this.insertEntityRecord(obj, entityType, schemas[entityType], sql);
				
				// Process nested entities and record relationships
				await this.processEntityRelationships(obj, entityType, schemas, sql, path);
			}
		}
		
		// Recursively explore nested objects
		for (const [key, value] of Object.entries(obj)) {
			await this.insertAllEntities(value, schemas, sql, [...path, key]);
		}
	}
	
	private async processEntityRelationships(entity: any, entityType: string, schemas: Record<string, TableSchema>, sql: any, path: string[]): Promise<void> {
		for (const [key, value] of Object.entries(entity)) {
			if (Array.isArray(value) && value.length > 0) {
				// Check if this array contains entities
				const firstItem = value.find(item => this.isEntity(item));
				if (firstItem) {
					const relatedEntityType = this.inferEntityType(firstItem, [key]);
					
					// Process all entities in this array and record relationships
					for (const item of value) {
						if (this.isEntity(item) && schemas[relatedEntityType]) {
							const relatedId = await this.insertEntityRecord(item, relatedEntityType, schemas[relatedEntityType], sql);
							
							// Track this relationship for junction table creation
							const relationshipKey = [entityType, relatedEntityType].sort().join('_');
							const relationships = this.relationshipData.get(relationshipKey) || new Set();
							const entityId = this.getEntityId(entity, entityType);
							
							// CRITICAL FIX: Only track relationship if both IDs are valid
							if (entityId && relatedId) {
								relationships.add(`${entityId}_${relatedId}`);
								this.relationshipData.set(relationshipKey, relationships);
							} else {
								// DEBUG: Log when relationship tracking fails
								console.warn(`Failed to track relationship: ${entityType}(${entityId}) -> ${relatedEntityType}(${relatedId})`);
							}
							
							// Recursively process nested entities
							await this.processEntityRelationships(item, relatedEntityType, schemas, sql, [...path, key]);
						}
					}
				}
			} else if (value && typeof value === 'object' && this.isEntity(value)) {
				// Single related entity
				const relatedEntityType = this.inferEntityType(value, [key]);
				if (schemas[relatedEntityType]) {
					const relatedId = await this.insertEntityRecord(value, relatedEntityType, schemas[relatedEntityType], sql);
					
					// Track single entity relationship
					const relationshipKey = [entityType, relatedEntityType].sort().join('_');
					const relationships = this.relationshipData.get(relationshipKey) || new Set();
					const entityId = this.getEntityId(entity, entityType);
					
					if (entityId && relatedId && schemas[relationshipKey]) {
						relationships.add(`${entityId}_${relatedId}`);
						this.relationshipData.set(relationshipKey, relationships);
					}
					
					await this.processEntityRelationships(value, relatedEntityType, schemas, sql, [...path, key]);
				}
			}
		}
	}
	
	private async insertEntityRecord(entity: any, tableName: string, schema: TableSchema, sql: any): Promise<number | string | null> {
		// Check if this entity was already processed
		const entityMap = this.processedEntities.get(tableName) || new Map();
		if (entityMap.has(entity)) {
			return entityMap.get(entity)!;
		}
		
		const rowData = await this.mapEntityToSchema(entity, schema, sql);
		if (Object.keys(rowData).length === 0) return null;
		
		const columns = Object.keys(rowData);
		const placeholders = columns.map(() => '?').join(', ');
		const values = Object.values(rowData);
		
		// CRITICAL FIX: Handle UUID-based IDs properly
		let insertedId: number | string | null = null;
		
		// If entity has a UUID-style ID, use it directly
		if (entity.id && (typeof entity.id === 'string' || typeof entity.id === 'number')) {
			insertedId = entity.id;
			// For string IDs, use REPLACE to handle conflicts
			const insertSQL = `INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
			sql.exec(insertSQL, ...values);
		} else {
			// For auto-increment IDs
			const insertSQL = `INSERT OR IGNORE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
			const result = sql.exec(insertSQL, ...values);
			
			// Get the last inserted row ID only if the insert succeeded
			if (result.changes > 0) {
				try {
					const lastIdResult = sql.exec(`SELECT last_insert_rowid() as id`);
					const lastIdRows = lastIdResult.toArray();
					if (lastIdRows.length === 1) {
						insertedId = lastIdRows[0]?.id || null;
					}
				} catch (error) {
					console.warn(`Failed to get last_insert_rowid for ${tableName}:`, error);
					insertedId = null;
				}
			} else {
				// Row already exists, find its ID
				try {
					const existingResult = sql.exec(`SELECT rowid FROM ${tableName} WHERE ${columns.map(col => `${col} = ?`).join(' AND ')} LIMIT 1`, ...values);
					const existingRows = existingResult.toArray();
					if (existingRows.length === 1) {
						insertedId = existingRows[0]?.rowid || null;
					}
				} catch (error) {
					console.warn(`Failed to find existing rowid for ${tableName}:`, error);
					insertedId = null;
				}
			}
		}
		
		// Track this entity with proper ID
		if (insertedId !== null) {
			entityMap.set(entity, insertedId);
			this.processedEntities.set(tableName, entityMap);
		}
		
		return insertedId;
	}
	
	private async insertJunctionTableRecords(data: any, schemas: Record<string, TableSchema>, sql: any): Promise<void> {
		// Only create junction table records for relationships that actually have data
		for (const [relationshipKey, relationshipPairs] of this.relationshipData.entries()) {
			if (schemas[relationshipKey]) {
				const [table1, table2] = relationshipKey.split('_');
				
				for (const pairKey of relationshipPairs) {
					const [id1, id2] = pairKey.split('_').map(Number);
					
					const insertSQL = `INSERT OR IGNORE INTO ${relationshipKey} (${table1}_id, ${table2}_id) VALUES (?, ?)`;
					sql.exec(insertSQL, id1, id2);
				}
			}
		}
	}
	
	private getEntityId(entity: any, entityType: string): number | string | null {
		const entityMap = this.processedEntities.get(entityType);
		return entityMap?.get(entity) || null;
	}
	
	private async mapEntityToSchema(obj: any, schema: TableSchema, sql: any): Promise<any> {
		const rowData: any = {};
		
		if (!obj || typeof obj !== 'object') {
			if (schema.columns.value) rowData.value = obj;
			return rowData;
		}
		
		for (const columnName of Object.keys(schema.columns)) {
			if (columnName === 'id' && schema.columns[columnName].includes('AUTOINCREMENT')) {
				continue;
			}
			
			let value = null;
			
			// Handle foreign key columns
			if (columnName.endsWith('_id') && !columnName.includes('_json')) {
				const baseKey = columnName.slice(0, -3);
				const originalKey = this.findOriginalKey(obj, baseKey);
				if (originalKey && obj[originalKey] && typeof obj[originalKey] === 'object') {
					value = (obj[originalKey] as any).id || null;
				}
			}
			// Handle prefixed columns (from nested scalar fields)
			else if (columnName.includes('_') && !columnName.endsWith('_json')) {
				const parts = columnName.split('_');
				if (parts.length >= 2) {
					const baseKey = parts[0];
					const subKey = parts.slice(1).join('_');
					const originalKey = this.findOriginalKey(obj, baseKey);
					if (originalKey && obj[originalKey] && typeof obj[originalKey] === 'object') {
						const nestedObj = obj[originalKey];
						const originalSubKey = this.findOriginalKey(nestedObj, subKey);
						if (originalSubKey && nestedObj[originalSubKey] !== undefined) {
							value = nestedObj[originalSubKey];
							if (typeof value === 'boolean') value = value ? 1 : 0;
						}
					}
				}
			}
			// Handle JSON columns with chunking
			else if (columnName.endsWith('_json')) {
				const baseKey = columnName.slice(0, -5);
				const originalKey = this.findOriginalKey(obj, baseKey);
				if (originalKey && obj[originalKey] && typeof obj[originalKey] === 'object') {
					value = await this.chunkingEngine.smartJsonStringify(obj[originalKey], sql);
				}
			}
			// Handle regular columns
			else {
				const originalKey = this.findOriginalKey(obj, columnName);
				if (originalKey && obj[originalKey] !== undefined) {
					value = obj[originalKey];
					if (typeof value === 'boolean') value = value ? 1 : 0;
					
					// Skip arrays of entities (they're handled via junction tables)
					if (Array.isArray(value) && value.length > 0 && this.isEntity(value[0])) {
						continue;
					}
				}
			}
			
			if (value !== null && value !== undefined) {
				rowData[columnName] = value;
			}
		}
		
		return rowData;
	}
	
	// Entity detection and type inference (reuse logic from SchemaInferenceEngine)
	private isEntity(obj: any): boolean {
		if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
		
		const hasId = obj.id !== undefined || obj._id !== undefined;
		const fieldCount = Object.keys(obj).length;
		const hasMultipleFields = fieldCount >= 2;
		
		const hasEntityFields = obj.name !== undefined || obj.title !== undefined || 
			obj.description !== undefined || obj.type !== undefined;
		
		return hasId || (hasMultipleFields && hasEntityFields);
	}
	
	private inferEntityType(obj: any, path: string[]): string {
		if (obj.__typename) return this.sanitizeTableName(obj.__typename);
		if (obj.type && typeof obj.type === 'string') return this.sanitizeTableName(obj.type);
		
		if (path.length > 0) {
			const lastPath = path[path.length - 1];
			if (lastPath === 'edges' && path.length > 1) {
				return this.sanitizeTableName(path[path.length - 2]);
			}
			if (lastPath.endsWith('s') && lastPath.length > 1) {
				return this.sanitizeTableName(lastPath.slice(0, -1));
			}
			return this.sanitizeTableName(lastPath);
		}
		
		return 'entity_' + Math.random().toString(36).substr(2, 9);
	}
	
	private sanitizeTableName(name: string): string {
		if (!name || typeof name !== 'string') {
			return 'table_' + Math.random().toString(36).substr(2, 9);
		}
		
		let sanitized = name
			.replace(/[^a-zA-Z0-9_]/g, '_')
			.replace(/_{2,}/g, '_')  // Replace multiple underscores with single
			.replace(/^_|_$/g, '')  // Remove leading/trailing underscores
			.toLowerCase();
		
		// Ensure it doesn't start with a number
		if (/^[0-9]/.test(sanitized)) {
			sanitized = 'table_' + sanitized;
		}
		
		// Ensure it's not empty and not a SQL keyword
		if (!sanitized || sanitized.length === 0) {
			sanitized = 'table_' + Math.random().toString(36).substr(2, 9);
		}
		
		// Handle SQL reserved words
		const reservedWords = ['table', 'index', 'view', 'column', 'primary', 'key', 'foreign', 'constraint'];
		if (reservedWords.includes(sanitized)) {
			sanitized = sanitized + '_table';
		}
		
		return sanitized;
	}
	
	private findOriginalKey(obj: any, sanitizedKey: string): string | null {
		const keys = Object.keys(obj);
		
		// Direct match
		if (keys.includes(sanitizedKey)) return sanitizedKey;
		
		// Find key that sanitizes to the same value
		return keys.find(key => 
			this.sanitizeColumnName(key) === sanitizedKey
		) || null;
	}
	
	private sanitizeColumnName(name: string): string {
		if (!name || typeof name !== 'string') {
			return 'column_' + Math.random().toString(36).substr(2, 9);
		}
		
		// Convert camelCase to snake_case
		let snakeCase = name
			.replace(/([A-Z])/g, '_$1')
			.toLowerCase()
			.replace(/[^a-zA-Z0-9_]/g, '_')
			.replace(/_{2,}/g, '_')  // Replace multiple underscores with single
			.replace(/^_|_$/g, ''); // Remove leading/trailing underscores
		
		// Ensure it doesn't start with a number
		if (/^[0-9]/.test(snakeCase)) {
			snakeCase = 'col_' + snakeCase;
		}
		
		// Ensure it's not empty
		if (!snakeCase || snakeCase.length === 0) {
			snakeCase = 'column_' + Math.random().toString(36).substr(2, 9);
		}
		
		// Handle common DGIdb abbreviations properly
		const dgidbTerms: Record<string, string> = {
			'entrezid': 'entrez_id',
			'displayname': 'display_name',
			'conceptid': 'concept_id',
			'drugname': 'drug_name',
			'genename': 'gene_name',
			'interactiontype': 'interaction_type',
			'sourcetype': 'source_type',
			'sourcedb': 'source_db',
			'pmids': 'pmids'
		};
		
		const result = dgidbTerms[snakeCase] || snakeCase;
		
		// Handle SQL reserved words
		const reservedWords = ['table', 'index', 'view', 'column', 'primary', 'key', 'foreign', 'constraint', 'order', 'group', 'select', 'from', 'where'];
		if (reservedWords.includes(result)) {
			return result + '_col';
		}
		
		return result;
	}

	private async insertSimpleRow(obj: any, tableName: string, schema: TableSchema, sql: any): Promise<void> {
		const rowData = await this.mapObjectToSimpleSchema(obj, schema, sql);
		if (Object.keys(rowData).length === 0 && !(tableName === 'scalar_data' && obj === null)) return; // Allow inserting null for scalar_data

		const columns = Object.keys(rowData);
		const placeholders = columns.map(() => '?').join(', ');
		const values = Object.values(rowData);

		const insertSQL = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
		sql.exec(insertSQL, ...values);
	}

	private async mapObjectToSimpleSchema(obj: any, schema: TableSchema, sql: any): Promise<any> {
		const rowData: any = {};

		if (obj === null || typeof obj !== 'object') {
			if (schema.columns.value) { // For scalar_data or array_data of primitives
				rowData.value = obj;
			} else if (Object.keys(schema.columns).length > 0) {
				// This case should ideally not be hit if schema generation is right for primitives
				// but as a fallback, if there's a column, try to put it there.
				const firstCol = Object.keys(schema.columns)[0];
				rowData[firstCol] = obj;
			}
			return rowData;
		}

		for (const columnName of Object.keys(schema.columns)) {
			let valueToInsert = undefined;
			let originalKeyFound = false;

			if (columnName.endsWith('_json')) {
				const baseKey = columnName.slice(0, -5);
				const originalKey = this.findOriginalKey(obj, baseKey);
				if (originalKey && obj[originalKey] !== undefined) {
					valueToInsert = await this.chunkingEngine.smartJsonStringify(obj[originalKey], sql);
					originalKeyFound = true;
				}
			} else {
				const originalKey = this.findOriginalKey(obj, columnName);
				if (originalKey && obj[originalKey] !== undefined) {
					const val = obj[originalKey];
					if (typeof val === 'boolean') {
						valueToInsert = val ? 1 : 0;
					} else if (typeof val === 'object' && val !== null) {
						// This should not happen if schema is from extractSimpleFields, which JSONifies nested objects.
						// If it does, it implies a mismatch. For safety, try to JSON stringify.
						valueToInsert = await this.chunkingEngine.smartJsonStringify(val, sql);
					} else {
						valueToInsert = val;
					}
					originalKeyFound = true;
				}
			}

			if (originalKeyFound && valueToInsert !== undefined) {
				rowData[columnName] = valueToInsert;
			} else if (obj.hasOwnProperty(columnName) && obj[columnName] !== undefined){ // Direct match as last resort
				// This handles cases where sanitized names might not be used or `findOriginalKey` fails but direct prop exists
				const val = obj[columnName];
				if (typeof val === 'boolean') valueToInsert = val ? 1:0;
				else if (typeof val === 'object' && val !== null) valueToInsert = await this.chunkingEngine.smartJsonStringify(val, sql);
				else valueToInsert = val;
				rowData[columnName] = valueToInsert;
			}
		}
		return rowData;
	}
} 