import { MapSource } from '../model/TaskGraphModel';

function cleanPath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

export function sourceContainsPathRule(source: MapSource, filePath: string): boolean {
	const file = cleanPath(filePath);
	const sourcePath = cleanPath(source.path);
	if (source.type === 'file') return file === sourcePath;
	return sourcePath === '' || file.startsWith(`${sourcePath}/`);
}

export interface SourcePathResolution {
	filePaths: string[];
	missing: MapSource[];
}

export function resolveSourcePathRules(
	sources: MapSource[],
	markdownPaths: string[],
	folderPaths: string[],
): SourcePathResolution {
	const markdownSet = new Set(markdownPaths.map(cleanPath));
	const folderSet = new Set(folderPaths.map(cleanPath));
	const selected = new Set<string>();
	const missing: MapSource[] = [];

	sources.forEach((source) => {
		const path = cleanPath(source.path);
		if (source.type === 'file') {
			if (markdownSet.has(path)) selected.add(path);
			else missing.push(source);
			return;
		}
		if (!folderSet.has(path)) {
			missing.push(source);
			return;
		}
		markdownSet.forEach((filePath) => {
			if (sourceContainsPathRule(source, filePath)) selected.add(filePath);
		});
	});

	return {
		filePaths: Array.from(selected).sort((a, b) => a.localeCompare(b)),
		missing,
	};
}
