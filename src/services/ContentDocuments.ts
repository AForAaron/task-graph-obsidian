import { App, normalizePath, TFile, TFolder } from 'obsidian';
import {
	DocumentEdge,
	DocumentNode,
	MapDocumentConfig,
	TaskMapConfig,
	TaskNode,
} from '../model/TaskGraphModel';
import {
	calculateDocumentStats,
	CONTENT_FOLDER_NAME,
	contentFolderForFile,
	documentPositionKey,
	documentTitle,
	sanitizeDocumentTitle,
} from './DocumentMetadata';

export {
	calculateDocumentStats,
	CONTENT_FOLDER_NAME,
	contentFolderForFile,
	documentPositionKey,
	documentTitle,
	sanitizeDocumentTitle,
} from './DocumentMetadata';

export function resolveDocumentPath(app: App, link: string, sourcePath: string): string {
	const linkWithoutExtension = link.replace(/\.md$/i, '');
	const destination = app.metadataCache.getFirstLinkpathDest(linkWithoutExtension, sourcePath);
	if (destination) return destination.path;
	return normalizePath(/\.md$/i.test(link) ? link : `${link}.md`);
}

export function collectDocumentPaths(
	app: App,
	map: TaskMapConfig,
	tasks: TaskNode[],
): Map<string, string[]> {
	const paths = new Map<string, string[]>();
	map.documents.forEach((document) => paths.set(document.path, []));
	tasks.forEach((task) => {
		task.documentLinks.forEach((link) => {
			const path = resolveDocumentPath(app, link, task.path);
			const taskIds = paths.get(path) ?? [];
			if (!taskIds.includes(task.id)) taskIds.push(task.id);
			paths.set(path, taskIds);
		});
	});
	return paths;
}

export async function loadDocumentNodes(
	app: App,
	map: TaskMapConfig,
	tasks: TaskNode[],
): Promise<DocumentNode[]> {
	const paths = collectDocumentPaths(app, map, tasks);
	return Promise.all(Array.from(paths, async ([path, linkedTaskIds]) => {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return {
				id: `doc:${path}`,
				nodeType: 'document' as const,
				path,
				title: documentTitle(path),
				excerpt: '',
				wordCount: 0,
				checklistDone: 0,
				checklistTotal: 0,
				mtime: 0,
				linkedTaskIds,
				missing: true,
			};
		}
		const content = await app.vault.cachedRead(file);
		const stats = calculateDocumentStats(content);
		return {
			id: `doc:${path}`,
			nodeType: 'document' as const,
			path,
			title: documentTitle(path),
			...stats,
			mtime: file.stat.mtime,
			linkedTaskIds,
			missing: false,
		};
	}));
}

export function buildDocumentEdges(documents: DocumentNode[]): DocumentEdge[] {
	return documents.flatMap((document) => document.linkedTaskIds.map((taskNodeId) => ({
		id: `document-edge:${taskNodeId}:${document.path}`,
		taskNodeId,
		documentNodeId: document.id,
	})));
}

export function registerDocument(
	map: TaskMapConfig,
	path: string,
	expanded = true,
): MapDocumentConfig {
	const normalizedPath = normalizePath(path);
	const matches = map.documents.filter((document) => normalizePath(document.path) === normalizedPath);
	const existing = matches[0];
	if (existing) {
		existing.path = normalizedPath;
		existing.expanded = expanded || matches.some((document) => document.expanded);
		map.documents = map.documents.filter((document) => (
			document === existing || normalizePath(document.path) !== normalizedPath
		));
		return existing;
	}
	const document = { path: normalizedPath, expanded };
	map.documents.push(document);
	return document;
}

export function replaceRegisteredDocumentPath(
	map: TaskMapConfig,
	oldPath: string,
	newPath: string,
): void {
	const oldNormalized = normalizePath(oldPath);
	const newNormalized = normalizePath(newPath);
	const previous = map.documents.filter((document) => (
		normalizePath(document.path) === oldNormalized
	));
	const expanded = previous.some((document) => document.expanded);
	map.documents = map.documents.filter((document) => (
		normalizePath(document.path) !== oldNormalized
	));
	if (previous.length > 0) registerDocument(map, newNormalized, expanded);

	const oldKey = documentPositionKey(oldNormalized);
	const newKey = documentPositionKey(newNormalized);
	if (map.nodePositions[oldKey] && !map.nodePositions[newKey]) {
		map.nodePositions[newKey] = map.nodePositions[oldKey];
	}
	delete map.nodePositions[oldKey];
}

export function removeRegisteredDocument(map: TaskMapConfig, path: string): void {
	map.documents = map.documents.filter((document) => document.path !== path);
	delete map.nodePositions[documentPositionKey(path)];
}

async function ensureFolder(app: App, path: string): Promise<void> {
	const parts = normalizePath(path).split('/').filter(Boolean);
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const existing = app.vault.getAbstractFileByPath(current);
		if (!existing) await app.vault.createFolder(current);
		else if (!(existing instanceof TFolder)) throw new Error(`无法创建文件夹：${current}`);
	}
}

export function uniqueDocumentPath(app: App, folder: string, baseName: string): string {
	let index = 1;
	let path = normalizePath(`${folder}/${baseName}.md`);
	while (app.vault.getAbstractFileByPath(path)) {
		index += 1;
		path = normalizePath(`${folder}/${baseName}-${index}.md`);
	}
	return path;
}

export async function moveContentDocumentBesideTask(
	app: App,
	file: TFile,
	taskFilePath: string,
): Promise<string> {
	const folder = contentFolderForFile(taskFilePath);
	await ensureFolder(app, folder);
	const destination = uniqueDocumentPath(app, folder, documentTitle(file.path));
	await app.fileManager.renameFile(file, destination);
	return destination;
}

export async function createContentDocument(
	app: App,
	sourceFilePath: string,
	title: string,
	taskId?: string,
): Promise<TFile> {
	const folder = contentFolderForFile(sourceFilePath);
	await ensureFolder(app, folder);
	const safeTitle = sanitizeDocumentTitle(title);
	const baseName = taskId ? `${taskId}-${safeTitle}` : safeTitle;
	const path = uniqueDocumentPath(app, folder, baseName);
	return app.vault.create(path, `# ${safeTitle}\n\n`);
}
