import { App } from 'obsidian';

export interface TasksApiV1 {
	createTaskLineModal(): Promise<string>;
	editTaskLineModal(taskLine: string): Promise<string>;
	executeToggleTaskDoneCommand(taskLine: string, path: string): string;
}

interface PluginRegistry {
	getPlugin(id: string): { apiV1?: TasksApiV1 } | null;
}

export function getTasksApi(app: App): TasksApiV1 | null {
	const registry = (app as App & { plugins?: PluginRegistry }).plugins;
	return registry?.getPlugin('obsidian-tasks-plugin')?.apiV1 ?? null;
}
