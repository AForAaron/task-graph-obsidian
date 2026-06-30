import { App, normalizePath, TFile, TFolder } from 'obsidian';
import { MapSource, TaskMapConfig } from '../model/TaskGraphModel';
import { sourceContainsPathRule } from './SourceRules';

export interface ResolvedMapSources {
	files: TFile[];
	missing: MapSource[];
}

export function sourceContainsPath(source: MapSource, filePath: string): boolean {
	return sourceContainsPathRule(source, filePath);
}

export function mapContainsPath(map: TaskMapConfig, filePath: string): boolean {
	return map.sources.some((source) => sourceContainsPath(source, filePath));
}

export function normalizeSources(sources: MapSource[]): MapSource[] {
	const unique = new Map<string, MapSource>();
	sources.forEach((source) => {
		const path = normalizePath(source.path);
		const key = `${source.type}:${path}`;
		unique.set(key, source.type === 'folder'
			? { type: 'folder', path, recursive: true }
			: { type: 'file', path });
	});
	return Array.from(unique.values());
}

export function resolveMapSources(app: App, map: TaskMapConfig): ResolvedMapSources {
	const files = new Map<string, TFile>();
	const missing: MapSource[] = [];

	map.sources.forEach((source) => {
		const abstractFile = app.vault.getAbstractFileByPath(normalizePath(source.path));
		if (source.type === 'file') {
			if (abstractFile instanceof TFile && abstractFile.extension === 'md') {
				files.set(abstractFile.path, abstractFile);
			} else {
				missing.push(source);
			}
			return;
		}

		if (!(abstractFile instanceof TFolder)) {
			missing.push(source);
			return;
		}
		app.vault.getMarkdownFiles().forEach((file) => {
			if (sourceContainsPath(source, file.path)) files.set(file.path, file);
		});
	});

	return {
		files: Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path, 'zh-CN')),
		missing,
	};
}

export function isSourceSelected(sources: MapSource[], type: MapSource['type'], path: string): boolean {
	const normalized = normalizePath(path);
	return sources.some((source) => source.type === type && normalizePath(source.path) === normalized);
}

export function toggleSource(
	sources: MapSource[],
	source: MapSource,
	selected: boolean,
): MapSource[] {
	const normalized = normalizePath(source.path);
	const next = sources.filter((item) => !(
		item.type === source.type && normalizePath(item.path) === normalized
	));
	if (selected) next.push(source.type === 'folder'
		? { type: 'folder', path: normalized, recursive: true }
		: { type: 'file', path: normalized });
	return normalizeSources(next);
}
