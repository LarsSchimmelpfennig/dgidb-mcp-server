/**
 * Core types for DGIdb MCP Server
 * Updated for MCP Protocol 2025-06-18 specification compliance
 */

export interface TableSchema {
    columns: Record<string, string>;
    sample_data: any[];
    relationships?: Record<string, RelationshipInfo>;
    _meta?: {
        created_at?: string;
        row_count?: number;
        last_updated?: string;
        operation_type?: "read-only" | "data_processing" | "schema_modification";
        mcp_protocol_version?: string;
    };
}

export interface RelationshipInfo {
    type: 'foreign_key' | 'junction_table';
    target_table: string;
    foreign_key_column?: string;
    junction_table_name?: string;
    _meta?: {
        strength?: number;
        confidence?: number;
        analysis_timestamp?: string;
    };
}

export interface ProcessingResult {
    success: boolean;
    message?: string;
    schemas?: Record<string, SchemaInfo>;
    table_count?: number;
    total_rows?: number;
    pagination?: PaginationInfo;
    _meta?: {
        processing_time_ms?: number;
        memory_usage?: number;
        optimization_hints?: string[];
        operation_type?: "read-only" | "data_processing" | "schema_modification";
        protocol_version?: string;
        timestamp?: string;
    };
}

export interface SchemaInfo {
    columns: Record<string, string>;
    row_count: number;
    sample_data: any[];
    relationships?: Record<string, RelationshipInfo>;
    _meta?: {
        inferred_at?: string;
        quality_score?: number;
        data_types_confidence?: Record<string, number>;
        operation_type?: "read-only" | "data_processing" | "schema_modification";
    };
}

export interface PaginationInfo {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    currentCount: number;
    totalCount: number | null;
    endCursor: string | null;
    startCursor: string | null;
    suggestion?: string;
    _meta?: {
        estimated_total?: number;
        query_cost?: number;
        rate_limit_remaining?: number;
        analysis_timestamp?: string;
    };
}

export interface EntityContext {
    entityData?: any;
    parentTable?: string;
    parentKey?: string;
    relationshipType?: 'one_to_one' | 'one_to_many' | 'many_to_many';
    _meta?: {
        context_depth?: number;
        entity_confidence?: number;
        operation_type?: "read-only" | "data_processing";
        protocol_compliance?: string;
    };
} 