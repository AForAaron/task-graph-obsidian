import {
	createTaskMap,
	DEFAULT_PLUGIN_DATA,
	DEFAULT_VIEWPORT,
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

function isSource(value: unknown): value is MapSource {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<MapSource>;
	return typeof candidate.path === 'string'
		&& (candidate.type === 'file' || candidate.type === 'folder');
}

function sanitizeMap(value: unknown, index: number): TaskMapConfig | null {
	if (!value || typeof value !== 'object') return null;
	const candidate = value as Partial<TaskMapConfig>;
	if (typeof candidate.id !== 'string' || !candidate.id) return null;
	return {
		id: candidate.id,
		name: typeof candidate.name === 'string' && candidate.name.trim()
			? candidate.name.trim()
			: `任务地图 ${index + 1}`,
		sources: Array.isArray(candidate.sources) ? candidate.sources.filter(isSource).map((source) => (
			source.type === 'folder'
				? { type: 'folder', path: source.path, recursive: true }
				: { type: 'file', path: source.path }
		)) : [],
		nodePositions: candidate.nodePositions && typeof candidate.nodePositions === 'object'
			? candidate.nodePositions
			: {},
		viewport: {
			x: Number.isFinite(candidate.viewport?.x) ? candidate.viewport!.x : DEFAULT_VIEWPORT.x,
			y: Number.isFinite(candidate.viewport?.y) ? candidate.viewport!.y : DEFAULT_VIEWPORT.y,
			scale: Number.isFinite(candidate.viewport?.scale) ? candidate.viewport!.scale : DEFAULT_VIEWPORT.scale,
		},
	};
}

export function migratePluginData(raw: unknown): TaskGraphPluginData {
	const input = (raw && typeof raw === 'object' ? raw : {}) as LegacyPluginData;
	const maps = Array.isArray(input.maps)
		? input.maps.map(sanitizeMap).filter((map): map is TaskMapConfig => Boolean(map))
		: [];

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
		version: 2,
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
