import {
	createTaskMap,
	DEFAULT_PLUGIN_DATA,
	DEFAULT_VIEWPORT,
	MapDocumentConfig,
	MapSource,
	TaskGraphPluginData,
	TaskMapConfig,
} from '../model/TaskGraphModel';

interface LegacyPluginData {
	lastScopePath?: unknown;
	showCompleted?: unknown;
	sourcePanelCollapsed?: unknown;
	maps?: unknown;
	activeMapId?: unknown;
}

function isDocument(value: unknown): value is MapDocumentConfig {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<MapDocumentConfig>;
	return typeof candidate.path === 'string' && Boolean(candidate.path);
}

function isSource(value: unknown): value is MapSource {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<MapSource>;
	return typeof candidate.path === 'string'
		&& (
			(candidate.type === 'file' && Boolean(candidate.path))
			|| candidate.type === 'folder'
		);
}

function sanitizePositions(value: unknown): Record<string, { x: number; y: number }> {
	if (!value || typeof value !== 'object') return {};
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter((entry): entry is [string, { x: number; y: number }] => {
				const position = entry[1] as { x?: unknown; y?: unknown } | null;
				return Boolean(position)
					&& Number.isFinite(position?.x)
					&& Number.isFinite(position?.y);
			})
			.map(([key, position]) => [key, { x: position.x, y: position.y }]),
	);
}

function sanitizeMap(value: unknown, index: number): TaskMapConfig | null {
	if (!value || typeof value !== 'object') return null;
	const candidate = value as Partial<TaskMapConfig>;
	if (typeof candidate.id !== 'string' || !candidate.id) return null;
	const sourceByKey = new Map<string, MapSource>();
	if (Array.isArray(candidate.sources)) {
		candidate.sources.filter(isSource).forEach((source) => {
			const path = source.path.replace(/^\/+|\/+$/g, '');
			const normalized: MapSource = source.type === 'folder'
				? { type: 'folder', path, recursive: true }
				: { type: 'file', path };
			sourceByKey.set(`${normalized.type}:${path}`, normalized);
		});
	}
	const documentsByPath = new Map<string, MapDocumentConfig>();
	if (Array.isArray(candidate.documents)) {
		candidate.documents.filter(isDocument).forEach((document) => {
			const path = document.path.replace(/^\/+/, '');
			const existing = documentsByPath.get(path);
			documentsByPath.set(path, {
				path,
				expanded: document.expanded !== false || existing?.expanded === true,
			});
		});
	}
	const scale = Number.isFinite(candidate.viewport?.scale)
		? Math.min(2, Math.max(0.2, candidate.viewport!.scale!))
		: DEFAULT_VIEWPORT.scale;
	return {
		id: candidate.id,
		name: typeof candidate.name === 'string' && candidate.name.trim()
			? candidate.name.trim()
			: `任务地图 ${index + 1}`,
		sources: Array.from(sourceByKey.values()),
		nodePositions: sanitizePositions(candidate.nodePositions),
		viewport: {
			x: Number.isFinite(candidate.viewport?.x) ? candidate.viewport!.x : DEFAULT_VIEWPORT.x,
			y: Number.isFinite(candidate.viewport?.y) ? candidate.viewport!.y : DEFAULT_VIEWPORT.y,
			scale,
		},
		documents: Array.from(documentsByPath.values()),
	};
}

export function migratePluginData(raw: unknown): TaskGraphPluginData {
	const input = (raw && typeof raw === 'object' ? raw : {}) as LegacyPluginData;
	const sanitizedMaps = Array.isArray(input.maps)
		? input.maps.map(sanitizeMap).filter((map): map is TaskMapConfig => Boolean(map))
		: [];
	const maps = Array.from(
		new Map(sanitizedMaps.map((map) => [map.id, map])).values(),
	);

	if (maps.length === 0) {
		const legacyPath = typeof input.lastScopePath === 'string' && input.lastScopePath !== '__all__'
			? input.lastScopePath
			: '';
		maps.push(createTaskMap(
			legacyPath ? '迁移的任务地图' : DEFAULT_PLUGIN_DATA.maps[0].name,
			legacyPath ? [{ type: 'file', path: legacyPath }] : [],
		));
	}

	const requestedActiveId = typeof input.activeMapId === 'string' ? input.activeMapId : '';
	const activeMapId = maps.some((map) => map.id === requestedActiveId)
		? requestedActiveId
		: maps[0].id;

	return {
		version: 3,
		maps,
		activeMapId,
		showCompleted: typeof input.showCompleted === 'boolean' ? input.showCompleted : true,
		sourcePanelCollapsed: typeof input.sourcePanelCollapsed === 'boolean'
			? input.sourcePanelCollapsed
			: false,
	};
}

export function renameSourcePaths(
	maps: TaskMapConfig[],
	oldPath: string,
	newPath: string,
): boolean {
	let changed = false;
	const oldPrefix = `${oldPath}/`;
	maps.forEach((map) => {
		map.sources.forEach((source) => {
			if (source.path === oldPath) {
				source.path = newPath;
				changed = true;
			} else if (source.path.startsWith(oldPrefix)) {
				source.path = `${newPath}/${source.path.slice(oldPrefix.length)}`;
				changed = true;
			}
		});
		map.documents.forEach((document) => {
			const nextPath = renamePathValue(document.path, oldPath, newPath);
			if (nextPath !== document.path) {
				document.path = nextPath;
				changed = true;
			}
		});
		const mergedDocuments = new Map<string, MapDocumentConfig>();
		map.documents.forEach((document) => {
			const existing = mergedDocuments.get(document.path);
			mergedDocuments.set(document.path, {
				path: document.path,
				expanded: document.expanded || existing?.expanded === true,
			});
		});
		map.documents = Array.from(mergedDocuments.values());

		const positionEntries = Object.entries(map.nodePositions);
		positionEntries.forEach(([key, position]) => {
			const filePrefix = `task:${oldPath}:`;
			const folderPrefix = `task:${oldPrefix}`;
			if (key.startsWith(filePrefix)) {
				delete map.nodePositions[key];
				map.nodePositions[`task:${newPath}:${key.slice(filePrefix.length)}`] = position;
				changed = true;
			} else if (key.startsWith(folderPrefix)) {
				delete map.nodePositions[key];
				map.nodePositions[`task:${newPath}/${key.slice(folderPrefix.length)}`] = position;
				changed = true;
			} else if (key === `doc:${oldPath}` || key.startsWith(`doc:${oldPrefix}`)) {
				const suffix = key === `doc:${oldPath}` ? '' : key.slice(`doc:${oldPrefix}`.length);
				delete map.nodePositions[key];
				map.nodePositions[`doc:${newPath}${suffix ? `/${suffix}` : ''}`] = position;
				changed = true;
			}
		});
	});
	return changed;
}

export function renamePathValue(path: string, oldPath: string, newPath: string): string {
	if (path === oldPath) return newPath;
	const oldPrefix = `${oldPath}/`;
	return path.startsWith(oldPrefix)
		? `${newPath}/${path.slice(oldPrefix.length)}`
		: path;
}
