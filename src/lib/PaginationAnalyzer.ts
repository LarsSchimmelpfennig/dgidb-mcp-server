import { PaginationInfo } from "./types.js";

export class PaginationAnalyzer {
	
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