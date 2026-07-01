import { App, normalizePath, TFile } from 'obsidian';
import { TaskNode } from '../model/TaskGraphModel';
import {
	addDependency,
	addDocumentLink,
	addTaskTag,
	ensureSuccessorTaskMetadata,
	ensureTaskId,
	removeDependency,
	removeDocumentLink,
	removeTaskTag,
	replaceTaskId,
	replaceDocumentLink,
	replaceTaskLineText,
	setTaskStarred,
} from './TaskLineMetadata';
import { createTaskId } from './TaskId';

export { createTaskId } from './TaskId';

function formatLocalDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

export function findTaskLine(lines: string[], task: TaskNode): number {
	const warnings = (task as TaskNode & { warnings?: string[] }).warnings;
	const duplicateId = warnings?.includes('duplicate-id') ?? false;
	if (task.stableId && !duplicateId) {
		const idPattern = new RegExp(`🆔\\s*${task.taskId}(?:\\s|$)`);
		const found = lines.findIndex((line) => idPattern.test(line));
		if (found >= 0) return found;
	}
	if (task.line >= 0 && task.line < lines.length && lines[task.line].includes(task.rawBody)) {
		return task.line;
	}
	return lines.findIndex((line) => line.includes(task.rawBody));
}

export function normalizeTaskLine(line: string): string {
	const trimmed = line.trim();
	if (/^(?:[-*+]|\d+\.)\s+\[[^\]\r\n]\]\s+/.test(trimmed)) return trimmed;
	return `- [ ] ${trimmed}`;
}

async function readTaskLocation(app: App, task: TaskNode): Promise<{
	file: TFile;
	content: string;
	lines: string[];
	lineIndex: number;
}> {
	const file = app.vault.getAbstractFileByPath(task.path);
	if (!(file instanceof TFile)) throw new Error(`找不到任务文件：${task.path}`);
	const content = await app.vault.read(file);
	const lines = content.split(/\r?\n/);
	const lineIndex = findTaskLine(lines, task);
	if (lineIndex < 0) throw new Error(`找不到任务：${task.text}`);
	return { file, content, lines, lineIndex };
}

export async function appendTaskLine(app: App, file: TFile, taskLine: string): Promise<void> {
	const normalized = normalizeTaskLine(taskLine);
	await app.vault.process(file, (content) => {
		if (!content) return `${normalized}\n`;
		return `${content.replace(/\s*$/, '')}\n${normalized}\n`;
	});
}

export function prepareNewTaskLine(taskLine: string, candidateId: string): {
	line: string;
	taskId: string;
} {
	return ensureTaskId(normalizeTaskLine(taskLine), candidateId);
}

export async function replaceTaskLine(
	app: App,
	task: TaskNode,
	replacement: string,
): Promise<void> {
	const location = await readTaskLocation(app, task);
	const original = location.lines[location.lineIndex];
	location.lines[location.lineIndex] = replaceTaskLineText(original, replacement);
	await app.vault.modify(location.file, location.lines.join('\n'));
}

type ContentMutation = (content: string) => string;

async function applyFileMutations(
	app: App,
	mutations: Map<TFile, ContentMutation[]>,
	afterWrite?: () => Promise<void>,
): Promise<void> {
	const originals = new Map<TFile, string>();
	const updated = new Map<TFile, string>();
	for (const [file, transforms] of mutations) {
		const original = await app.vault.read(file);
		originals.set(file, original);
		updated.set(file, transforms.reduce((content, transform) => transform(content), original));
	}
	const written: TFile[] = [];
	try {
		for (const [file, content] of updated) {
			await app.vault.modify(file, content);
			written.push(file);
		}
		if (afterWrite) await afterWrite();
	} catch (error) {
		let rollbackError: unknown = null;
		for (const file of written.reverse()) {
			try {
				await app.vault.modify(file, originals.get(file) ?? '');
			} catch (restoreError) {
				rollbackError ??= restoreError;
			}
		}
		if (rollbackError) {
			const originalMessage = error instanceof Error ? error.message : String(error);
			const rollbackMessage = rollbackError instanceof Error
				? rollbackError.message
				: String(rollbackError);
			throw new Error(`${originalMessage}；回滚写入失败：${rollbackMessage}`);
		}
		throw error;
	}
}

function addMutation(
	mutations: Map<TFile, ContentMutation[]>,
	file: TFile,
	mutation: ContentMutation,
): void {
	const list = mutations.get(file) ?? [];
	list.push(mutation);
	mutations.set(file, list);
}

function transformTaskLine(task: TaskNode, transform: (line: string) => string): ContentMutation {
	return (content) => {
		const lines = content.split(/\r?\n/);
		const index = findTaskLine(lines, task);
		if (index < 0) throw new Error(`找不到任务：${task.text}`);
		lines[index] = transform(lines[index]);
		return lines.join('\n');
	};
}

function insertTask(
	taskLine: string,
	anchor?: TaskNode,
	placement: 'before' | 'after' | 'end' = 'end',
): ContentMutation {
	return (content) => {
		const lines = content.split(/\r?\n/);
		if (anchor && placement !== 'end') {
			const index = findTaskLine(lines, anchor);
			if (index >= 0) {
				lines.splice(placement === 'before' ? index : index + 1, 0, taskLine);
				return lines.join('\n');
			}
		}
		if (!content.trim()) return `${taskLine}\n`;
		return `${content.replace(/\s*$/, '')}\n${taskLine}\n`;
	};
}

function fileForTask(app: App, task: TaskNode): TFile {
	const file = app.vault.getAbstractFileByPath(task.path);
	if (!(file instanceof TFile)) throw new Error(`找不到任务文件：${task.path}`);
	return file;
}

export interface SuccessorWriteResult {
	parentId: string;
	childId: string;
	parentWasUpdated: boolean;
}

export async function createSuccessorTask(
	app: App,
	parent: TaskNode,
	targetFile: TFile,
	childTaskLine: string,
	candidateParentId = createTaskId(),
	candidateChildId = createTaskId(),
): Promise<SuccessorWriteResult> {
	const parentId = parent.taskId ?? candidateParentId;
	const childMetadata = ensureSuccessorTaskMetadata(
		normalizeTaskLine(childTaskLine),
		parentId,
		candidateChildId,
	);
	const childLine = childMetadata.line;
	const parentFile = fileForTask(app, parent);
	const mutations = new Map<TFile, ContentMutation[]>();
	if (!parent.stableId) {
		addMutation(mutations, parentFile, transformTaskLine(
			parent,
			(line) => ensureTaskId(line, parentId).line,
		));
	}
	addMutation(
		mutations,
		targetFile,
		insertTask(childLine, targetFile.path === parent.path ? parent : undefined, 'after'),
	);
	await applyFileMutations(app, mutations);
	return { parentId, childId: childMetadata.childId, parentWasUpdated: !parent.stableId };
}

export interface RelationshipWriteResult {
	parentId: string;
	childId: string;
	parentWasUpdated: boolean;
	childWasUpdated: boolean;
}

export async function createPredecessorTask(
	app: App,
	child: TaskNode,
	targetFile: TFile,
	parentTaskLine: string,
	candidateParentId = createTaskId(),
	candidateChildId = createTaskId(),
): Promise<RelationshipWriteResult> {
	const parent = prepareNewTaskLine(parentTaskLine, candidateParentId);
	const childId = child.taskId ?? candidateChildId;
	const childFile = fileForTask(app, child);
	const mutations = new Map<TFile, ContentMutation[]>();
	addMutation(
		mutations,
		targetFile,
		insertTask(parent.line, targetFile.path === child.path ? child : undefined, 'before'),
	);
	addMutation(mutations, childFile, transformTaskLine(child, (line) => (
		addDependency(ensureTaskId(line, childId).line, parent.taskId)
	)));
	await applyFileMutations(app, mutations);
	return {
		parentId: parent.taskId,
		childId,
		parentWasUpdated: false,
		childWasUpdated: !child.stableId,
	};
}

export async function connectTasks(
	app: App,
	parent: TaskNode,
	child: TaskNode,
	candidateParentId = createTaskId(),
	candidateChildId = createTaskId(),
): Promise<RelationshipWriteResult> {
	const parentId = parent.taskId ?? candidateParentId;
	const childId = child.taskId ?? candidateChildId;
	const parentFile = fileForTask(app, parent);
	const childFile = fileForTask(app, child);
	const mutations = new Map<TFile, ContentMutation[]>();
	if (!parent.stableId) {
		addMutation(mutations, parentFile, transformTaskLine(
			parent,
			(line) => ensureTaskId(line, parentId).line,
		));
	}
	addMutation(mutations, childFile, transformTaskLine(child, (line) => (
		addDependency(ensureTaskId(line, childId).line, parentId)
	)));
	await applyFileMutations(app, mutations);
	return {
		parentId,
		childId,
		parentWasUpdated: !parent.stableId,
		childWasUpdated: !child.stableId,
	};
}

export async function removeTaskRelationship(
	app: App,
	parent: TaskNode,
	child: TaskNode,
): Promise<void> {
	if (!parent.taskId) throw new Error('前置任务缺少任务 ID');
	const childFile = fileForTask(app, child);
	const mutations = new Map<TFile, ContentMutation[]>();
	addMutation(mutations, childFile, transformTaskLine(
		child,
		(line) => removeDependency(line, parent.taskId!),
	));
	await applyFileMutations(app, mutations);
}

export async function setTaskStar(
	app: App,
	task: TaskNode,
	starred: boolean,
): Promise<void> {
	const location = await readTaskLocation(app, task);
	await replaceTaskLine(
		app,
		task,
		setTaskStarred(location.lines[location.lineIndex], starred),
	);
}

export async function changeTaskTag(
	app: App,
	task: TaskNode,
	tag: string,
	add: boolean,
): Promise<void> {
	const location = await readTaskLocation(app, task);
	await replaceTaskLine(
		app,
		task,
		add ? addTaskTag(location.lines[location.lineIndex], tag) : removeTaskTag(location.lines[location.lineIndex], tag),
	);
}

export async function changeTaskDocumentLink(
	app: App,
	task: TaskNode,
	path: string,
	add: boolean,
): Promise<void> {
	await changeTaskDocumentLinks(app, [{ task, path, add }]);
}

export async function renameTaskDocumentLink(
	app: App,
	task: TaskNode,
	oldPath: string,
	newPath: string,
): Promise<void> {
	await renameTaskDocumentLinks(app, [task], oldPath, newPath);
}

export interface TaskDocumentLinkChange {
	task: TaskNode;
	path: string;
	add: boolean;
}

function normalizeComparablePath(path: string): string {
	return normalizePath(/\.md$/i.test(path) ? path : `${path}.md`).replace(/^\/+/, '');
}

function resolveTaskDocumentPath(app: App, task: TaskNode, link: string): string {
	const withoutExtension = link.replace(/\.md$/i, '');
	const destination = app.metadataCache.getFirstLinkpathDest(withoutExtension, task.path);
	return destination?.path ?? normalizeComparablePath(link);
}

function documentLinkAliases(
	app: App,
	task: TaskNode,
	canonicalPath: string,
): string[] {
	const target = normalizeComparablePath(canonicalPath);
	return task.documentLinks.filter((link) => (
		normalizeComparablePath(resolveTaskDocumentPath(app, task, link)) === target
	));
}

export async function changeTaskDocumentLinks(
	app: App,
	changes: TaskDocumentLinkChange[],
	afterWrite?: () => Promise<void>,
): Promise<void> {
	const mutations = new Map<TFile, ContentMutation[]>();
	changes.forEach(({ task, path, add }) => {
		const aliases = add ? [] : documentLinkAliases(app, task, path);
		addMutation(
			mutations,
			fileForTask(app, task),
			transformTaskLine(task, (line) => (
				add
					? addDocumentLink(line, path)
					: removeDocumentLink(line, path, aliases)
			)),
		);
	});
	await applyFileMutations(app, mutations, afterWrite);
}

export async function renameTaskDocumentLinks(
	app: App,
	tasks: TaskNode[],
	oldPath: string,
	newPath: string,
	afterWrite?: () => Promise<void>,
	aliasesByTaskId?: Map<string, string[]>,
): Promise<void> {
	const mutations = new Map<TFile, ContentMutation[]>();
	tasks.forEach((task) => {
		const aliases = [
			...documentLinkAliases(app, task, oldPath),
			...(aliasesByTaskId?.get(task.id) ?? []),
		];
		addMutation(
			mutations,
			fileForTask(app, task),
			transformTaskLine(task, (line) => (
				replaceDocumentLink(line, oldPath, newPath, aliases)
			)),
		);
	});
	await applyFileMutations(app, mutations, afterWrite);
}

export async function assignTaskId(
	app: App,
	task: TaskNode,
	candidateId: string,
	replaceExisting = false,
): Promise<string> {
	const file = fileForTask(app, task);
	const mutations = new Map<TFile, ContentMutation[]>();
	addMutation(mutations, file, transformTaskLine(task, (line) => (
		replaceExisting ? replaceTaskId(line, candidateId) : ensureTaskId(line, candidateId).line
	)));
	await applyFileMutations(app, mutations);
	return candidateId;
}

export async function repairTaskIds(
	app: App,
	tasks: TaskNode[],
	existingIds: Iterable<string>,
): Promise<Map<string, string>> {
	const used = new Set(existingIds);
	const assigned = new Map<string, string>();
	const mutations = new Map<TFile, ContentMutation[]>();
	for (const task of tasks) {
		if (task.taskId) continue;
		const id = createTaskId(used);
		used.add(id);
		assigned.set(task.id, id);
		addMutation(
			mutations,
			fileForTask(app, task),
			transformTaskLine(task, (line) => ensureTaskId(line, id).line),
		);
	}
	await applyFileMutations(app, mutations);
	return assigned;
}

export async function deleteTaskAndReferences(
	app: App,
	task: TaskNode,
	dependents: TaskNode[],
): Promise<void> {
	const mutations = new Map<TFile, ContentMutation[]>();
	if (task.taskId) {
		for (const dependent of dependents) {
			addMutation(
				mutations,
				fileForTask(app, dependent),
				transformTaskLine(dependent, (line) => removeDependency(line, task.taskId!)),
			);
		}
	}
	addMutation(mutations, fileForTask(app, task), (content) => {
		const lines = content.split(/\r?\n/);
		const index = findTaskLine(lines, task);
		if (index < 0) throw new Error(`找不到任务：${task.text}`);
		lines.splice(index, 1);
		return lines.join('\n');
	});
	await applyFileMutations(app, mutations);
}

export async function toggleTaskCompletion(app: App, task: TaskNode): Promise<void> {
	const file = app.vault.getAbstractFileByPath(task.path);
	if (!(file instanceof TFile)) {
		throw new Error(`找不到任务文件：${task.path}`);
	}

	await app.vault.process(file, (content) => {
		const lines = content.split(/\r?\n/);
		const lineIndex = findTaskLine(lines, task);
		if (lineIndex < 0) {
			throw new Error(`找不到任务：${task.text}`);
		}

		const line = lines[lineIndex];
		const markerMatch = line.match(/^(\s*(?:>\s*)*(?:[-*+]|\d+\.)\s+)\[([ xX/\-])\](.*)$/);
		if (!markerMatch) {
			throw new Error(`无法识别任务行：${task.text}`);
		}

		const currentlyDone = markerMatch[2].toLowerCase() === 'x';
		let suffix = markerMatch[3];
		if (currentlyDone) {
			suffix = suffix.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/g, '');
		} else if (!/✅\s*\d{4}-\d{2}-\d{2}/.test(suffix)) {
			suffix = `${suffix.trimEnd()} ✅ ${formatLocalDate(new Date())}`;
		}
		lines[lineIndex] = `${markerMatch[1]}[${currentlyDone ? ' ' : 'x'}]${suffix}`;
		return lines.join('\n');
	});
}

export async function markTaskInProgress(app: App, task: TaskNode): Promise<void> {
	const location = await readTaskLocation(app, task);
	const line = location.lines[location.lineIndex];
	const updated = line.replace(
		/^(\s*(?:>\s*)*(?:[-*+]|\d+\.)\s+)\[([ xX/\-])\]/,
		'$1[/]',
	);
	const withStart = /🛫\s*\d{4}-\d{2}-\d{2}/.test(updated)
		? updated
		: `${updated.trimEnd()} 🛫 ${formatLocalDate(new Date())}`;
	await replaceTaskLine(app, task, withStart);
}
