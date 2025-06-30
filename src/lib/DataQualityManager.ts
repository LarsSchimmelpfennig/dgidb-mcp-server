import { TableSchema } from "./types.js";

export interface DataQualityReport {
	relationshipIntegrity: RelationshipIntegrityReport;
	dataCompleteness: DataCompletenessReport;
	performanceMetrics: PerformanceMetrics;
	recommendations: string[];
	_meta?: {
		analysis_timestamp?: string;
		analysis_duration_ms?: number;
		schema_version?: string;
	};
}

export interface RelationshipIntegrityReport {
	totalJunctionTables: number;
	populatedJunctionTables: number;
	emptyJunctionTables: string[];
	orphanedRecords: { table: string; count: number }[];
	_meta?: {
		analysis_depth?: 'basic' | 'comprehensive';
		foreign_key_violations_checked?: number;
	};
}

export interface DataCompletenessReport {
	totalRecords: number;
	duplicateRecords: { table: string; count: number }[];
	nullFields: { table: string; field: string; nullCount: number }[];
	completenessScore: number; // 0-100
	_meta?: {
		tables_analyzed?: number;
		columns_analyzed?: number;
		analysis_coverage?: number; // percentage of schema analyzed
	};
}

export interface PerformanceMetrics {
	queryComplexityScore: number;
	estimatedExecutionTime: number;
	resourceWarnings: string[];
	_meta?: {
		query_pattern?: string;
		optimization_suggestions?: string[];
		estimated_memory_usage?: number;
	};
}

export class DataQualityManager {
	
	/**
	 * Validates relationship integrity and provides actionable recommendations
	 */
	async validateRelationshipIntegrity(dataAccessId: string, schemas: Record<string, TableSchema>, sql: any): Promise<RelationshipIntegrityReport> {
		const junctionTables = Object.keys(schemas).filter(name => 
			name.includes('_') && schemas[name].columns && 
			Object.keys(schemas[name].columns).some(col => col.endsWith('_id'))
		);
		
		const emptyJunctionTables: string[] = [];
		const orphanedRecords: { table: string; count: number }[] = [];
		
		for (const junctionTable of junctionTables) {
			try {
				const countResult = sql.exec(`SELECT COUNT(*) as count FROM ${junctionTable}`);
				const countRows = countResult.toArray();
				
				let count = 0;
				if (countRows.length === 1) {
					count = countRows[0]?.count || 0;
				}
				
				if (count === 0) {
					emptyJunctionTables.push(junctionTable);
				} else {
					// Check for orphaned records (foreign keys pointing to non-existent records)
					const schema = schemas[junctionTable];
					const foreignKeyColumns = Object.keys(schema.columns).filter(col => col.endsWith('_id'));
					
					for (const fkCol of foreignKeyColumns) {
						const baseTable = fkCol.replace('_id', '');
						if (schemas[baseTable]) {
							const orphanResult = sql.exec(`
								SELECT COUNT(*) as count 
								FROM ${junctionTable} j 
								WHERE j.${fkCol} IS NOT NULL 
								AND NOT EXISTS (SELECT 1 FROM ${baseTable} b WHERE b.id = j.${fkCol})
							`);
							const orphanRows = orphanResult.toArray();
							
							let orphanCount = 0;
							if (orphanRows.length === 1) {
								orphanCount = orphanRows[0]?.count || 0;
							}
							
							if (orphanCount > 0) {
								orphanedRecords.push({ table: junctionTable, count: orphanCount });
							}
						}
					}
				}
			} catch (error) {
				// Table might not exist or have issues
				emptyJunctionTables.push(junctionTable);
			}
		}
		
		return {
			totalJunctionTables: junctionTables.length,
			populatedJunctionTables: junctionTables.length - emptyJunctionTables.length,
			emptyJunctionTables,
			orphanedRecords
		};
	}
	
	/**
	 * Analyzes data completeness and identifies quality issues
	 */
	async analyzeDataCompleteness(schemas: Record<string, TableSchema>, sql: any): Promise<DataCompletenessReport> {
		const duplicateRecords: { table: string; count: number }[] = [];
		const nullFields: { table: string; field: string; nullCount: number }[] = [];
		let totalRecords = 0;
		let totalFields = 0;
		let nullFieldCount = 0;
		
		for (const [tableName, schema] of Object.entries(schemas)) {
			if (tableName.includes('_') && Object.keys(schema.columns).some(col => col.endsWith('_id'))) {
				continue; // Skip junction tables
			}
			
			try {
				const tableCountResult = sql.exec(`SELECT COUNT(*) as count FROM ${tableName}`);
				const tableCountRows = tableCountResult.toArray();
				
				let tableCount = 0;
				if (tableCountRows.length === 1) {
					tableCount = tableCountRows[0]?.count || 0;
				}
				
				totalRecords += tableCount;
				
				if (tableCount > 0) {
					// Check for duplicates by comparing distinct vs total counts
					const distinctResult = sql.exec(`SELECT COUNT(DISTINCT *) as count FROM ${tableName}`);
					const distinctRows = distinctResult.toArray();
					
					let distinctCount = 0;
					if (distinctRows.length === 1) {
						distinctCount = distinctRows[0]?.count || 0;
					}
					
					const duplicates = tableCount - distinctCount;
					if (duplicates > 0) {
						duplicateRecords.push({ table: tableName, count: duplicates });
					}
					
					// Analyze null fields
					for (const columnName of Object.keys(schema.columns)) {
						if (columnName === 'id') continue; // Skip ID columns
						
						const nullResult = sql.exec(`SELECT COUNT(*) as count FROM ${tableName} WHERE ${columnName} IS NULL`);
						const nullRows = nullResult.toArray();
						
						let nullCount = 0;
						if (nullRows.length === 1) {
							nullCount = nullRows[0]?.count || 0;
						}
						
						totalFields += tableCount;
						nullFieldCount += nullCount;
						
						if (nullCount > 0) {
							nullFields.push({ table: tableName, field: columnName, nullCount });
						}
					}
				}
			} catch (error) {
				// Table might not exist
				console.warn(`Could not analyze table ${tableName}:`, error);
			}
		}
		
		const completenessScore = totalFields > 0 ? Math.round(((totalFields - nullFieldCount) / totalFields) * 100) : 100;
		
		return {
			totalRecords,
			duplicateRecords,
			nullFields,
			completenessScore
		};
	}
	
	/**
	 * Analyzes SQL query complexity and provides performance warnings
	 */
	analyzeQueryComplexity(sql: string): PerformanceMetrics {
		const normalizedSql = sql.toLowerCase().trim();
		let complexityScore = 0;
		const resourceWarnings: string[] = [];
		
		// Basic complexity scoring
		if (normalizedSql.includes('cross join')) {
			complexityScore += 10;
			resourceWarnings.push('CROSS JOIN detected - may produce large result sets');
		}
		
		if (normalizedSql.includes('group by')) complexityScore += 2;
		if (normalizedSql.includes('order by')) complexityScore += 1;
		if (normalizedSql.includes('distinct')) complexityScore += 1;
		
		// Count number of JOINs
		const joinCount = (normalizedSql.match(/\bjoin\b/g) || []).length;
		complexityScore += joinCount * 2;
		
		if (joinCount > 5) {
			resourceWarnings.push(`High number of JOINs (${joinCount}) - consider breaking into smaller queries`);
		}
		
		// Check for potentially expensive patterns
		if (normalizedSql.includes('like %')) {
			complexityScore += 3;
			resourceWarnings.push('Wildcard LIKE patterns can be slow on large datasets');
		}
		
		if (normalizedSql.includes('not exists') || normalizedSql.includes('not in')) {
			complexityScore += 2;
			resourceWarnings.push('NOT EXISTS/NOT IN queries can be expensive');
		}
		
		// Estimate execution time (very rough)
		let estimatedTime = Math.min(complexityScore * 100, 10000); // Cap at 10 seconds
		
		if (complexityScore > 15) {
			resourceWarnings.push('High complexity query - consider adding LIMIT clause');
		}
		
		return {
			queryComplexityScore: complexityScore,
			estimatedExecutionTime: estimatedTime,
			resourceWarnings
		};
	}
	
	/**
	 * Generates comprehensive data quality report with actionable recommendations
	 */
	async generateQualityReport(dataAccessId: string, schemas: Record<string, TableSchema>, sql: any): Promise<DataQualityReport> {
		const [relationshipIntegrity, dataCompleteness] = await Promise.all([
			this.validateRelationshipIntegrity(dataAccessId, schemas, sql),
			this.analyzeDataCompleteness(schemas, sql)
		]);
		
		const recommendations: string[] = [];
		
		// Relationship recommendations
		if (relationshipIntegrity.emptyJunctionTables.length > 0) {
			recommendations.push(`Fix ${relationshipIntegrity.emptyJunctionTables.length} empty junction tables to enable complex queries`);
		}
		
		if (relationshipIntegrity.orphanedRecords.length > 0) {
			recommendations.push(`Clean up ${relationshipIntegrity.orphanedRecords.length} tables with orphaned foreign key references`);
		}
		
		// Data quality recommendations
		if (dataCompleteness.duplicateRecords.length > 0) {
			const totalDuplicates = dataCompleteness.duplicateRecords.reduce((sum, record) => sum + record.count, 0);
			recommendations.push(`Remove ${totalDuplicates} duplicate records across ${dataCompleteness.duplicateRecords.length} tables`);
		}
		
		if (dataCompleteness.completenessScore < 80) {
			recommendations.push(`Data completeness is ${dataCompleteness.completenessScore}% - investigate missing data patterns`);
		}
		
		// Add performance recommendations
		if (Object.keys(schemas).length > 20) {
			recommendations.push('Large number of tables detected - consider using pagination for better performance');
		}
		
		return {
			relationshipIntegrity,
			dataCompleteness,
			performanceMetrics: { queryComplexityScore: 0, estimatedExecutionTime: 0, resourceWarnings: [] }, // Will be populated when analyzing specific queries
			recommendations
		};
	}
	
	/**
	 * Attempts to repair common data quality issues automatically
	 */
	async repairDataQualityIssues(schemas: Record<string, TableSchema>, sql: any): Promise<{ repaired: string[], failed: string[] }> {
		const repaired: string[] = [];
		const failed: string[] = [];
		
		// Only attempt safe repairs for read-only operations
		try {
			// Create indexes for better performance (if supported)
			for (const [tableName, schema] of Object.entries(schemas)) {
				if (schema.columns.id) {
					try {
						sql.exec(`CREATE INDEX IF NOT EXISTS idx_${tableName}_id ON ${tableName}(id)`);
						repaired.push(`Created index on ${tableName}.id`);
					} catch (error) {
						failed.push(`Could not create index on ${tableName}.id`);
					}
				}
			}
		} catch (error) {
			failed.push('Index creation not supported in this environment');
		}
		
		return { repaired, failed };
	}
} 