import { TableSchema } from "./types.js";
import { ChunkingEngine } from "./ChunkingEngine.js";

// Enhanced schema inference engine with proper relational decomposition
export class SchemaInferenceEngine {
	private chunkingEngine = new ChunkingEngine();
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
				// Check if this array contains entities that should be related
				if (value.length > 0 && this.isEntity(value[0])) {
					// This will be handled as a relationship via junction table, skip for now
					continue;
							} else {
				// Store as JSON for analysis
				this.addColumnType(columnTypes, columnName + '_json', 'TEXT');
				rowData[columnName + '_json'] = JSON.stringify(value);
			}
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
						this.addColumnType(columnTypes, columnName + '_json', 'TEXT');
						rowData[columnName + '_json'] = JSON.stringify(value);
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
		
		// Handle common DGIdb/genomics abbreviations properly
		const genomicsTerms: Record<string, string> = {
			'entrezid': 'entrez_id',
			'displayname': 'display_name',
			'varianttype': 'variant_type',
			'evidencelevel': 'evidence_level',
			'evidencetype': 'evidence_type',
			'evidencedirection': 'evidence_direction',
			'sourcetype': 'source_type',
			'molecularprofile': 'molecular_profile',
			'genomicchange': 'genomic_change',
			'drugname': 'drug_name',
			'genename': 'gene_name',
			'conceptid': 'concept_id',
			'interactiontype': 'interaction_type'
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