import { DurableObject } from "cloudflare:workers";

// Types for better extensibility
interface TableSchema {
	columns: Record<string, string>;
	sample_data: any[];
	relationships?: Record<string, RelationshipInfo>;
}

interface RelationshipInfo {
	type: 'foreign_key' | 'junction_table';
	target_table: string;
	foreign_key_column?: string;
	junction_table_name?: string;
}

interface ProcessingResult {
	success: boolean;
	message?: string;
	schemas?: Record<string, SchemaInfo>;
	table_count?: number;
	total_rows?: number;
	pagination?: PaginationInfo;
}

interface SchemaInfo {
	columns: Record<string, string>;
	row_count: number;
	sample_data: any[];
	relationships?: Record<string, RelationshipInfo>;
}

interface PaginationInfo {
	hasNextPage: boolean;
	hasPreviousPage: boolean;
	currentCount: number;
	totalCount: number | null;
	endCursor: string | null;
	startCursor: string | null;
	suggestion?: string;
}

interface EntityContext {
	entityData?: any;
	parentTable?: string;
	parentKey?: string;
	relationshipType?: 'one_to_one' | 'one_to_many' | 'many_to_many';
}

// Enhanced schema inference engine with proper relational decomposition
class SchemaInferenceEngine {
	private discoveredEntities: Map<string, any[]> = new Map();
	private entityRelationships: Map<string, Set<string>> = new Map(); // Now tracks unique relationships only
	
	inferFromJSON(data: any): Record<string, TableSchema> {
		// Reset state for new inference
		this.discoveredEntities.clear();
		this.entityRelationships.clear();
		
		const schemas: Record<string, TableSchema> = {};
		
		this.discoverEntities(data, []);
		
		// Only proceed if we found meaningful entities
		if (this.discoveredEntities.size > 0) {
			this.createSchemasFromEntities(schemas);
		} else {
			// Fallback for simple data
			if (typeof data !== 'object' || data === null || Array.isArray(data)) {
				const tableName = Array.isArray(data) ? 'array_data' : 'scalar_data';
				schemas[tableName] = this.createSchemaFromPrimitiveOrSimpleArray(data, tableName);
			} else {
				schemas.root_object = this.createSchemaFromObject(data, 'root_object');
			}
		}

		return schemas;
	}
	
	private discoverEntities(obj: any, path: string[], parentEntityType?: string): void {
		if (!obj || typeof obj !== 'object') {
			return;
		}

		if (Array.isArray(obj)) {
			if (obj.length > 0) {
				// Process all items in the array - they should be the same entity type
				let arrayEntityType: string | null = null;
				
				for (const item of obj) {
					if (this.isEntity(item)) {
						if (!arrayEntityType) {
							arrayEntityType = this.inferEntityType(item, path);
						}
						
						// Add to discovered entities
						const entitiesOfType = this.discoveredEntities.get(arrayEntityType) || [];
						entitiesOfType.push(item);
						this.discoveredEntities.set(arrayEntityType, entitiesOfType);
						
						// Record relationship if this array belongs to a parent entity
						if (parentEntityType && path.length > 0) {
							const fieldName = path[path.length - 1];
							if (fieldName !== 'nodes' && fieldName !== 'edges') { // Skip GraphQL wrapper fields
								this.recordRelationship(parentEntityType, arrayEntityType);
							}
						}
						
						// Recursively process nested objects within this entity
						this.processEntityProperties(item, arrayEntityType);
					}
				}
			}
			return;
		}

		// Handle GraphQL edges pattern
		if (obj.edges && Array.isArray(obj.edges)) {
			const nodes = obj.edges.map((edge: any) => edge.node).filter(Boolean);
			if (nodes.length > 0) {
				this.discoverEntities(nodes, path, parentEntityType);
			}
			return;
		}

		// Process individual entities
		if (this.isEntity(obj)) {
			const entityType = this.inferEntityType(obj, path);
			
			// Add to discovered entities
			const entitiesOfType = this.discoveredEntities.get(entityType) || [];
			entitiesOfType.push(obj);
			this.discoveredEntities.set(entityType, entitiesOfType);
			
			// Process properties of this entity
			this.processEntityProperties(obj, entityType);
			return;
		}

		// For non-entity objects, recursively explore their properties
		for (const [key, value] of Object.entries(obj)) {
			this.discoverEntities(value, [...path, key], parentEntityType);
		}
	}
	
	private processEntityProperties(entity: any, entityType: string): void {
		for (const [key, value] of Object.entries(entity)) {
			if (Array.isArray(value) && value.length > 0) {
				// Check if this array contains entities
				const firstItem = value.find(item => this.isEntity(item));
				if (firstItem) {
					const relatedEntityType = this.inferEntityType(firstItem, [key]);
					this.recordRelationship(entityType, relatedEntityType);
					
					// Process all entities in this array
					value.forEach(item => {
						if (this.isEntity(item)) {
							const entitiesOfType = this.discoveredEntities.get(relatedEntityType) || [];
							entitiesOfType.push(item);
							this.discoveredEntities.set(relatedEntityType, entitiesOfType);
							
							// Recursively process nested entities
							this.processEntityProperties(item, relatedEntityType);
						}
					});
				}
			} else if (value && typeof value === 'object' && this.isEntity(value)) {
				// Single related entity
				const relatedEntityType = this.inferEntityType(value, [key]);
				this.recordRelationship(entityType, relatedEntityType);
				
				const entitiesOfType = this.discoveredEntities.get(relatedEntityType) || [];
				entitiesOfType.push(value);
				this.discoveredEntities.set(relatedEntityType, entitiesOfType);
				
				// Recursively process nested entities
				this.processEntityProperties(value, relatedEntityType);
			}
		}
	}
	
	private isEntity(obj: any): boolean {
		if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
		
		// An entity typically has an ID field or multiple meaningful fields
		const hasId = obj.id !== undefined || obj._id !== undefined;
		const fieldCount = Object.keys(obj).length;
		const hasMultipleFields = fieldCount >= 2;
		
		// Check for common entity patterns
		const hasEntityFields = obj.name !== undefined || obj.title !== undefined || 
			obj.description !== undefined || obj.type !== undefined;
		
		return hasId || (hasMultipleFields && hasEntityFields);
	}
	
	private inferEntityType(obj: any, path: string[]): string {
		// Try to infer type from object properties (e.g., __typename)
		if (obj.__typename) return this.sanitizeTableName(obj.__typename);
		if (obj.type && typeof obj.type === 'string' && !['edges', 'node'].includes(obj.type.toLowerCase())) {
			return this.sanitizeTableName(obj.type);
		}
		
		// Infer from path context, attempting to singularize
		if (path.length > 0) {
			let lastName = path[path.length - 1];

			// Handle GraphQL patterns
			if (lastName === 'node' && path.length > 1) {
				lastName = path[path.length - 2];
				if (lastName === 'edges' && path.length > 2) {
					lastName = path[path.length - 3];
				}
			} else if (lastName === 'edges' && path.length > 1) {
				lastName = path[path.length - 2];
			}
			
			// Attempt to singularize common plural forms
			const sanitized = this.sanitizeTableName(lastName);
			if (sanitized.endsWith('ies')) {
				return sanitized.slice(0, -3) + 'y';
			} else if (sanitized.endsWith('s') && !sanitized.endsWith('ss') && sanitized.length > 1) {
				const potentialSingular = sanitized.slice(0, -1);
				if (potentialSingular.length > 1) return potentialSingular;
			}
			return sanitized;
		}
		
		// Fallback naming if no other inference is possible
		return 'entity_' + Math.random().toString(36).substr(2, 9);
	}
	
	private recordRelationship(fromTable: string, toTable: string): void {
		if (fromTable === toTable) return; // Avoid self-relationships
		
		const relationshipKey = `${fromTable}_${toTable}`;
		const reverseKey = `${toTable}_${fromTable}`;
		
		const fromRelationships = this.entityRelationships.get(fromTable) || new Set();
		const toRelationships = this.entityRelationships.get(toTable) || new Set();
		
		// Only record if not already recorded in either direction
		if (!fromRelationships.has(toTable) && !toRelationships.has(fromTable)) {
			fromRelationships.add(toTable);
			this.entityRelationships.set(fromTable, fromRelationships);
		}
	}
	
	private createSchemasFromEntities(schemas: Record<string, TableSchema>): void {
		// Create main entity tables
		for (const [entityType, entities] of this.discoveredEntities.entries()) {
			if (entities.length === 0) continue;
			
			const columnTypes: Record<string, Set<string>> = {};
			const sampleData: any[] = [];
			
			entities.forEach((entity, index) => {
				if (index < 3) {
					sampleData.push(this.extractEntityFields(entity, columnTypes, entityType));
				} else {
					this.extractEntityFields(entity, columnTypes, entityType);
				}
			});
			
			const columns = this.resolveColumnTypes(columnTypes);
			this.ensureIdColumn(columns);
			
			schemas[entityType] = {
				columns,
				sample_data: sampleData
			};
		}
		
		// Create junction tables for many-to-many relationships
		this.createJunctionTableSchemas(schemas);
	}
	
	private extractEntityFields(obj: any, columnTypes: Record<string, Set<string>>, entityType: string): any {
		const rowData: any = {};
		
		if (!obj || typeof obj !== 'object') {
			this.addColumnType(columnTypes, 'value', this.getSQLiteType(obj));
			return { value: obj };
		}
		
		for (const [key, value] of Object.entries(obj)) {
			const columnName = this.sanitizeColumnName(key);
			
			if (Array.isArray(value)) {
				// Always store arrays as JSON, regardless of whether they contain entities
				// This allows for flexible querying of the array data
				this.addColumnType(columnTypes, columnName, 'JSON');
				rowData[columnName] = JSON.stringify(value);
			} else if (value && typeof value === 'object') {
				if (this.isEntity(value)) {
					// This is a related entity - create foreign key
					const foreignKeyColumn = columnName + '_id';
					this.addColumnType(columnTypes, foreignKeyColumn, 'INTEGER');
					rowData[foreignKeyColumn] = (value as any).id || null;
				} else {
					// Complex object that's not an entity
					if (this.hasScalarFields(value)) {
						// Flatten simple fields with prefixed names
						for (const [subKey, subValue] of Object.entries(value)) {
							if (!Array.isArray(subValue) && typeof subValue !== 'object') {
								const prefixedColumn = columnName + '_' + this.sanitizeColumnName(subKey);
								this.addColumnType(columnTypes, prefixedColumn, this.getSQLiteType(subValue));
								rowData[prefixedColumn] = typeof subValue === 'boolean' ? (subValue ? 1 : 0) : subValue;
							}
						}
					} else {
						// Store complex object as JSON
						this.addColumnType(columnTypes, columnName, 'JSON');
						rowData[columnName] = JSON.stringify(value);
					}
				}
			} else {
				// Scalar values
				this.addColumnType(columnTypes, columnName, this.getSQLiteType(value));
				rowData[columnName] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
			}
		}
		
		return rowData;
	}
	
	private hasScalarFields(obj: any): boolean {
		if (!obj || typeof obj !== 'object') return false;
		return Object.values(obj).some(value => 
			typeof value !== 'object' || value === null
		);
	}
	
	private createJunctionTableSchemas(schemas: Record<string, TableSchema>): void {
		const junctionTables = new Set<string>();
		
		for (const [fromTable, relatedTables] of this.entityRelationships.entries()) {
			for (const toTable of relatedTables) {
				// Create a consistent junction table name (alphabetical order to avoid duplicates)
				const junctionName = [fromTable, toTable].sort().join('_');
				
				if (!junctionTables.has(junctionName)) {
					junctionTables.add(junctionName);
					
					schemas[junctionName] = {
						columns: {
							id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
							[`${fromTable}_id`]: 'INTEGER',
							[`${toTable}_id`]: 'INTEGER'
						},
						sample_data: []
					};
				}
			}
		}
	}
	
	private createSchemaFromPrimitiveOrSimpleArray(data: any, tableName: string): TableSchema {
		const columnTypes: Record<string, Set<string>> = {};
		const sampleData: any[] = [];
		
		if (Array.isArray(data)) {
			data.slice(0,3).forEach(item => {
				// This simple version just takes the value, assumes items are scalar or will be JSON stringified.
				const row = this.extractSimpleFields(item, columnTypes);
				sampleData.push(row);
			});
			if (data.length > 3) {
				data.slice(3).forEach(item => this.extractSimpleFields(item, columnTypes));
			}
		} else { // Scalar data
			const row = this.extractSimpleFields(data, columnTypes);
			sampleData.push(row);
		}
		
		const columns = this.resolveColumnTypes(columnTypes);
		// No automatic 'id' for these simple tables unless the data happens to have one.
		if (!Object.keys(columns).includes('id') && !Object.keys(columns).includes('value')) {
			// If only one column and it is not named 'value', rename it to value for consistency
			const colNames = Object.keys(columns);
			if(colNames.length === 1 && colNames[0] !== 'value'){
				columns['value'] = columns[colNames[0]];
				delete columns[colNames[0]];
				// also update sample data key
				sampleData.forEach(s => { s['value'] = s[colNames[0]]; delete s[colNames[0]]; });
			}
		}
		if (Object.keys(columns).length === 0 && data === null) { // handle null input
		    columns['value'] = 'TEXT';
		}

		return { columns, sample_data: sampleData };
	}

	private createSchemaFromObject(obj: any, tableName: string): TableSchema {
		const columnTypes: Record<string, Set<string>> = {};
		const rowData = this.extractSimpleFields(obj, columnTypes);
		const columns = this.resolveColumnTypes(columnTypes);
		// No automatic 'id' for this type of table either.
		return { columns, sample_data: [rowData] };
	}

	private extractSimpleFields(obj: any, columnTypes: Record<string, Set<string>>): any {
		const rowData: any = {};
		
		if (obj === null || typeof obj !== 'object') {
			this.addColumnType(columnTypes, 'value', this.getSQLiteType(obj));
			return { value: obj };
		}
		
		if (Array.isArray(obj)) { // Should not happen if called from createSchemaFromPrimitiveOrSimpleArray with array items
			this.addColumnType(columnTypes, 'array_data_json', 'TEXT');
			return { array_data_json: JSON.stringify(obj) };
		}

		for (const [key, value] of Object.entries(obj)) {
			const columnName = this.sanitizeColumnName(key);
			if (value === null || typeof value !== 'object') {
				this.addColumnType(columnTypes, columnName, this.getSQLiteType(value));
				rowData[columnName] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
			} else {
				// For nested objects/arrays within this simple structure, store as JSON.
				this.addColumnType(columnTypes, columnName + '_json', 'TEXT');
				rowData[columnName + '_json'] = JSON.stringify(value);
			}
		}
		return rowData;
	}
	
	private addColumnType(columnTypes: Record<string, Set<string>>, column: string, type: string): void {
		if (!columnTypes[column]) columnTypes[column] = new Set();
		columnTypes[column].add(type);
	}
	
	private resolveColumnTypes(columnTypes: Record<string, Set<string>>): Record<string, string> {
		const columns: Record<string, string> = {};
		
		for (const [columnName, types] of Object.entries(columnTypes)) {
			if (types.size === 1) {
				columns[columnName] = Array.from(types)[0];
			} else {
				// Mixed types - prefer TEXT > REAL > INTEGER
				columns[columnName] = types.has('TEXT') ? 'TEXT' : types.has('REAL') ? 'REAL' : 'INTEGER';
			}
		}
		
		return columns;
	}
	
	private ensureIdColumn(columns: Record<string, string>): void {
		if (!columns.id) {
			columns.id = "INTEGER PRIMARY KEY AUTOINCREMENT";
		} else if (columns.id === "INTEGER") {
			columns.id = "INTEGER PRIMARY KEY";
		}
	}
	
	private getSQLiteType(value: any): string {
		if (value === null || value === undefined) return "TEXT";
		switch (typeof value) {
			case 'number': return Number.isInteger(value) ? "INTEGER" : "REAL";
			case 'boolean': return "INTEGER";
			case 'string': return "TEXT";
			default: return "TEXT";
		}
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
		
		// Handle common genomics abbreviations properly
		const genomicsTerms: Record<string, string> = {
			'entrezid': 'entrez_id',
			'displayname': 'display_name',
			'varianttype': 'variant_type',
			'evidencelevel': 'evidence_level',
			'evidencetype': 'evidence_type',
			'evidencedirection': 'evidence_direction',
			'sourcetype': 'source_type',
			'molecularprofile': 'molecular_profile',
			'genomicchange': 'genomic_change'
		};
		
		const result = genomicsTerms[snakeCase] || snakeCase;
		
		// Handle SQL reserved words
		const reservedWords = ['table', 'index', 'view', 'column', 'primary', 'key', 'foreign', 'constraint', 'order', 'group', 'select', 'from', 'where'];
		if (reservedWords.includes(result)) {
			return result + '_col';
		}
		
		return result;
	}
}

// Enhanced data insertion engine with relational support
class DataInsertionEngine {
	private processedEntities: Map<string, Map<any, number>> = new Map();
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
							await this.insertEntityRecord(item, relatedEntityType, schemas[relatedEntityType], sql);
							
							// Track this relationship for junction table creation
							const relationshipKey = [entityType, relatedEntityType].sort().join('_');
							const relationships = this.relationshipData.get(relationshipKey) || new Set();
							const entityId = this.getEntityId(entity, entityType);
							const relatedId = this.getEntityId(item, relatedEntityType);
							
							if (entityId && relatedId) {
								relationships.add(`${entityId}_${relatedId}`);
								this.relationshipData.set(relationshipKey, relationships);
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
					await this.insertEntityRecord(value, relatedEntityType, schemas[relatedEntityType], sql);
					await this.processEntityRelationships(value, relatedEntityType, schemas, sql, [...path, key]);
				}
			}
		}
	}
	
	private async insertEntityRecord(entity: any, tableName: string, schema: TableSchema, sql: any): Promise<number | null> {
		// Check if this entity was already processed
		const entityMap = this.processedEntities.get(tableName) || new Map();
		if (entityMap.has(entity)) {
			return entityMap.get(entity)!;
		}
		
		const rowData = this.mapEntityToSchema(entity, schema);
		if (Object.keys(rowData).length === 0) return null;
		
		const columns = Object.keys(rowData);
		const placeholders = columns.map(() => '?').join(', ');
		const values = Object.values(rowData);
		
		// Use INSERT OR IGNORE to handle potential duplicates
		const insertSQL = `INSERT OR IGNORE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
		sql.exec(insertSQL, ...values);
		
		// Get the inserted or existing ID
		let insertedId: number | null = null;
		if (rowData.id) {
			// If we have the ID in the data, use it
			insertedId = rowData.id;
		} else {
			// Otherwise get the last inserted row ID
			insertedId = sql.exec(`SELECT last_insert_rowid() as id`).one()?.id || null;
		}
		
		// Track this entity
		if (insertedId) {
			entityMap.set(entity, insertedId);
			this.processedEntities.set(tableName, entityMap);
		}
		
		return insertedId;
	}
	
	private async insertJunctionTableRecords(data: any, schemas: Record<string, TableSchema>, sql: any): Promise<void> {
		// Only create junction table records for relationships that actually have data
		for (const [relationshipKey, relationshipPairs] of this.relationshipData.entries()) {
			if (schemas[relationshipKey]) {
				// Use the same alphabetical ordering logic as schema creation
				const tableParts = relationshipKey.split('_');
				if (tableParts.length >= 2) {
					// For multi-word table names like "positive_modulator", we need to reconstruct properly
					// Find the correct split point by checking what tables exist
					let table1: string = '';
					let table2: string = '';
					
					// Try different split points to find valid table names
					for (let i = 1; i < tableParts.length; i++) {
						const possibleTable1 = tableParts.slice(0, i).join('_');
						const possibleTable2 = tableParts.slice(i).join('_');
						
						// Check if both parts correspond to actual entity tables
						if (schemas[possibleTable1] && schemas[possibleTable2]) {
							table1 = possibleTable1;
							table2 = possibleTable2;
							break;
						}
					}
					
					// If we couldn't find a proper split, fall back to simple split
					if (!table1 || !table2) {
						[table1, table2] = tableParts;
					}
					
					// Ensure consistent alphabetical ordering (same as schema creation)
					const [orderedTable1, orderedTable2] = [table1, table2].sort();
				
				for (const pairKey of relationshipPairs) {
					const [id1, id2] = pairKey.split('_').map(Number);
					
						// Map the IDs to the correct columns based on alphabetical order
						let firstId, secondId;
						if (table1 === orderedTable1) {
							firstId = id1;
							secondId = id2;
						} else {
							firstId = id2;
							secondId = id1;
						}
						
						const insertSQL = `INSERT OR IGNORE INTO ${relationshipKey} (${orderedTable1}_id, ${orderedTable2}_id) VALUES (?, ?)`;
						sql.exec(insertSQL, firstId, secondId);
					}
				}
			}
		}
	}
	
	private getEntityId(entity: any, entityType: string): number | null {
		const entityMap = this.processedEntities.get(entityType);
		return entityMap?.get(entity) || null;
	}
	
	private mapEntityToSchema(obj: any, schema: TableSchema): any {
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
			// Handle JSON columns
			else if (columnName.endsWith('_json')) {
				const baseKey = columnName.slice(0, -5);
				const originalKey = this.findOriginalKey(obj, baseKey);
				if (originalKey && obj[originalKey] && typeof obj[originalKey] === 'object') {
					value = JSON.stringify(obj[originalKey]);
				}
			}
			// Handle regular columns
			else {
				const originalKey = this.findOriginalKey(obj, columnName);
				if (originalKey && obj[originalKey] !== undefined) {
					value = obj[originalKey];
					if (typeof value === 'boolean') value = value ? 1 : 0;
					
					// Check if this is a JSON column and handle arrays appropriately
					if (schema.columns[columnName] === 'JSON' && Array.isArray(value)) {
						// For JSON columns, always stringify the array regardless of content
						value = JSON.stringify(value);
					} else if (Array.isArray(value) && value.length > 0 && this.isEntity(value[0])) {
						// Skip arrays of entities for non-JSON columns (they're handled via junction tables)
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
		
		// Handle common genomics abbreviations properly
		const genomicsTerms: Record<string, string> = {
			'entrezid': 'entrez_id',
			'displayname': 'display_name',
			'varianttype': 'variant_type',
			'evidencelevel': 'evidence_level',
			'evidencetype': 'evidence_type',
			'evidencedirection': 'evidence_direction',
			'sourcetype': 'source_type',
			'molecularprofile': 'molecular_profile',
			'genomicchange': 'genomic_change'
		};
		
		const result = genomicsTerms[snakeCase] || snakeCase;
		
		// Handle SQL reserved words
		const reservedWords = ['table', 'index', 'view', 'column', 'primary', 'key', 'foreign', 'constraint', 'order', 'group', 'select', 'from', 'where'];
		if (reservedWords.includes(result)) {
			return result + '_col';
		}
		
		return result;
	}

	private async insertSimpleRow(obj: any, tableName: string, schema: TableSchema, sql: any): Promise<void> {
		const rowData = this.mapObjectToSimpleSchema(obj, schema);
		if (Object.keys(rowData).length === 0 && !(tableName === 'scalar_data' && obj === null)) return; // Allow inserting null for scalar_data

		const columns = Object.keys(rowData);
		const placeholders = columns.map(() => '?').join(', ');
		const values = Object.values(rowData);

		const insertSQL = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
		sql.exec(insertSQL, ...values);
	}

	private mapObjectToSimpleSchema(obj: any, schema: TableSchema): any {
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

		if (Array.isArray(obj)) { // For root_object schemas where a field might be an array
			// This function (mapObjectToSimpleSchema) is for a single row. If an array needs to be a column, it should be JSON.
			// This case likely means the schema is `root_object` and `obj` is one of its fields being mapped.
			// The schema definition for `root_object` via `extractSimpleFields` handles JSON stringification.
			// So, this specific path in mapObjectToSimpleSchema might be redundant if schema is well-defined.
			// For safety, if a column expects `_json` for this array, it will be handled by the loop below.
		}

		for (const columnName of Object.keys(schema.columns)) {
			let valueToInsert = undefined;
			let originalKeyFound = false;

			if (columnName.endsWith('_json')) {
				const baseKey = columnName.slice(0, -5);
				const originalKey = this.findOriginalKey(obj, baseKey);
				if (originalKey && obj[originalKey] !== undefined) {
					valueToInsert = JSON.stringify(obj[originalKey]);
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
						valueToInsert = JSON.stringify(val);
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
				else if (typeof val === 'object' && val !== null) valueToInsert = JSON.stringify(val);
				else valueToInsert = val;
				rowData[columnName] = valueToInsert;
			}
		}
		return rowData;
	}
}

// Pagination analyzer - clean utility
class PaginationAnalyzer {
	
	static extractInfo(data: any): PaginationInfo {
		const result: PaginationInfo = {
			hasNextPage: false,
			hasPreviousPage: false,
			currentCount: 0,
			totalCount: null,
			endCursor: null,
			startCursor: null
		};
		
		const pageInfo = this.findPageInfo(data);
		if (pageInfo) {
			Object.assign(result, {
				hasNextPage: pageInfo.hasNextPage || false,
				hasPreviousPage: pageInfo.hasPreviousPage || false,
				endCursor: pageInfo.endCursor,
				startCursor: pageInfo.startCursor
			});
		}
		
		result.totalCount = this.findTotalCount(data);
		result.currentCount = this.countCurrentItems(data);
		
		if (result.hasNextPage) {
			result.suggestion = `Use pagination to get more than ${result.currentCount} records. Add "pageInfo { hasNextPage endCursor }" to your query and use "after: \\"${result.endCursor}\\"" for next page.`;
		}
		
		return result;
	}
	
	private static findPageInfo(obj: any): any {
		if (!obj || typeof obj !== 'object') return null;
		if (obj.pageInfo && typeof obj.pageInfo === 'object') return obj.pageInfo;
		
		for (const value of Object.values(obj)) {
			const found = this.findPageInfo(value);
			if (found) return found;
		}
		return null;
	}
	
	private static findTotalCount(obj: any): number | null {
		if (!obj || typeof obj !== 'object') return null;
		if (typeof obj.totalCount === 'number') return obj.totalCount;
		
		for (const value of Object.values(obj)) {
			const found = this.findTotalCount(value);
			if (found !== null) return found;
		}
		return null;
	}
	
	private static countCurrentItems(obj: any): number {
		// Count edges arrays first
		const edgesArrays: any[][] = [];
		this.findEdgesArrays(obj, edgesArrays);
		
		if (edgesArrays.length > 0) {
			return edgesArrays.reduce((sum, edges) => sum + edges.length, 0);
		}
		
		// Fallback to general array counting
		return this.countArrayItems(obj);
	}
	
	private static findEdgesArrays(obj: any, result: any[][]): void {
		if (!obj || typeof obj !== 'object') return;
		if (Array.isArray(obj.edges)) result.push(obj.edges);
		
		for (const value of Object.values(obj)) {
			this.findEdgesArrays(value, result);
		}
	}
	
	private static countArrayItems(obj: any): number {
		if (!obj || typeof obj !== 'object') return 0;
		
		let count = 0;
		for (const value of Object.values(obj)) {
			if (Array.isArray(value)) {
				count += value.length;
			} else if (typeof value === 'object') {
				count += this.countArrayItems(value);
			}
		}
		return count;
	}
}

// Main Durable Object class - clean and focused
export class JsonToSqlDO extends DurableObject {
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
					const validType = this.validateSQLiteType(type);
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

	private truncateSampleData(sampleData: any[], columns: Record<string, string>): any[] {
		const maxJsonLength = 200; // Maximum length for JSON field previews
		const maxArrayItems = 3; // Maximum array items to show in preview
		
		return sampleData.map(row => {
			const truncatedRow: any = {};
			
			for (const [key, value] of Object.entries(row)) {
				const columnType = columns[key];
				
				if (columnType === 'JSON' && typeof value === 'string') {
					try {
						const parsed = JSON.parse(value);
						if (Array.isArray(parsed)) {
							// For arrays, show count and first few items
							const preview = parsed.slice(0, maxArrayItems);
							const truncated = preview.length < parsed.length;
							truncatedRow[key] = `[Array: ${parsed.length} items${truncated ? `, showing first ${preview.length}` : ''}] ${JSON.stringify(preview)}${truncated ? '...' : ''}`;
						} else if (typeof parsed === 'object' && parsed !== null) {
							// For objects, show structure summary
							const keys = Object.keys(parsed);
							if (keys.length <= 5) {
								truncatedRow[key] = value.length <= maxJsonLength ? value : `${value.substring(0, maxJsonLength)}...`;
							} else {
								truncatedRow[key] = `{Object: ${keys.length} keys} ${JSON.stringify(keys.slice(0, 3))}...`;
							}
						} else {
							// For primitive values in JSON columns
							truncatedRow[key] = value.length <= maxJsonLength ? value : `${value.substring(0, maxJsonLength)}...`;
						}
					} catch (e) {
						// If JSON parsing fails, treat as regular string
						truncatedRow[key] = value.length <= maxJsonLength ? value : `${value.substring(0, maxJsonLength)}...`;
					}
				} else if (typeof value === 'string' && value.length > maxJsonLength) {
					// Truncate long text fields
					truncatedRow[key] = `${value.substring(0, maxJsonLength)}...`;
				} else {
					// Keep value as-is for normal fields
					truncatedRow[key] = value;
				}
			}
			
			return truncatedRow;
		});
	}

	private async generateMetadata(schemas: Record<string, TableSchema>): Promise<Partial<ProcessingResult>> {
		const metadata: Partial<ProcessingResult> = {
			schemas: {},
			table_count: Object.keys(schemas).length,
			total_rows: 0
		};

		for (const [tableName, schema] of Object.entries(schemas)) {
			try {
				const countResult = this.ctx.storage.sql.exec(`SELECT COUNT(*) as count FROM ${tableName}`);
				const countRow = countResult.one();
				const rowCount = typeof countRow?.count === 'number' ? countRow.count : 0;

				const sampleResult = this.ctx.storage.sql.exec(`SELECT * FROM ${tableName} LIMIT 3`);
				const sampleData = sampleResult.toArray();
				
				// Truncate large JSON fields in sample data to prevent context window crowding
				const truncatedSampleData = this.truncateSampleData(sampleData, schema.columns);

				metadata.schemas![tableName] = {
					columns: schema.columns,
					row_count: rowCount,
					sample_data: truncatedSampleData
				};

				metadata.total_rows! += rowCount;

			} catch (error) {
				// Continue with other tables on error
				continue;
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
					
					// Get row count
					const countResult = this.ctx.storage.sql.exec(`SELECT COUNT(*) as count FROM ${tableName}`).one();
					const rowCount = typeof countResult?.count === 'number' ? countResult.count : 0;
					
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
				genomics_specific: [
					"-- Evidence by disease:",
					"SELECT d.name, COUNT(*) as evidence_count FROM evidence_item e JOIN disease d ON e.disease_id = d.id GROUP BY d.id",
					"-- Variant frequency analysis:",
					"SELECT variant_type, COUNT(*) FROM variant GROUP BY variant_type",
					"-- Gene-disease associations:",
					"SELECT g.name as gene, d.name as disease FROM gene g JOIN evidence_item e ON g.id = e.gene_id JOIN disease d ON e.disease_id = d.id"
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