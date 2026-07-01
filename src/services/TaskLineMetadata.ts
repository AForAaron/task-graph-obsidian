const TASK_ID_REGEX = /🆔\s*([A-Za-z0-9_-]+)/;
const DEPENDENCY_REGEX = /⛔\s*([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)/g;
const DOCUMENT_LINK_REGEX = /(?:^|\s)📄\s*\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]*)?\]\]/gu;

function mapTaskBody(line: string, transform: (body: string) => string): string {
	const match = line.match(/^(\s*(?:>\s*)*(?:[-*+]|\d+\.)\s+\[[^\]\r\n]\]\s+)(.*)$/);
	return match ? `${match[1]}${transform(match[2])}` : transform(line);
}

function normalizeTaskLine(line: string): string {
	const trimmed = line.trim();
	if (/^(?:[-*+]|\d+\.)\s+\[[^\]\r\n]\]\s+/.test(trimmed)) return trimmed;
	return `- [ ] ${trimmed}`;
}

function taskLineCore(line: string): string {
	const normalized = normalizeTaskLine(line);
	const match = normalized.match(/^(?:[-*+]|\d+\.)\s+(\[[^\]\r\n]\]\s+.*)$/);
	return match?.[1] ?? normalized;
}

export function replaceTaskLineText(original: string, replacement: string): string {
	const prefix = original.match(/^(\s*(?:>\s*)*(?:[-*+]|\d+\.)\s+)/)?.[1];
	return prefix ? `${prefix}${taskLineCore(replacement)}` : normalizeTaskLine(replacement);
}

function withTaskId(line: string, id: string): string {
	if (TASK_ID_REGEX.test(line)) return line;
	const dependencyIndex = line.search(/\s+⛔\s*[A-Za-z0-9_-]+/);
	if (dependencyIndex >= 0) {
		return `${line.slice(0, dependencyIndex).trimEnd()} 🆔 ${id}${line.slice(dependencyIndex)}`;
	}
	return `${line.trimEnd()} 🆔 ${id}`;
}

export function readDependencyIds(line: string): string[] {
	return Array.from(new Set(
		Array.from(line.matchAll(DEPENDENCY_REGEX))
			.flatMap((match) => match[1].split(',').map((id) => id.trim()))
			.filter(Boolean),
	));
}

function replaceDependencies(line: string, ids: string[]): string {
	return mapTaskBody(line, (body) => {
		const stripped = body.replace(DEPENDENCY_REGEX, '').replace(/\s{2,}/g, ' ').trimEnd();
		return ids.length > 0 ? `${stripped} ⛔ ${ids.join(',')}` : stripped;
	});
}

export function addDependency(line: string, parentId: string): string {
	const dependencies = readDependencyIds(line);
	if (!dependencies.includes(parentId)) dependencies.push(parentId);
	return replaceDependencies(line, dependencies);
}

export function removeDependency(line: string, parentId: string): string {
	return replaceDependencies(line, readDependencyIds(line).filter((id) => id !== parentId));
}

export function setTaskStarred(line: string, starred: boolean): string {
	const withoutStar = line.replace(/\s*⭐(?=\s|$)/gu, '').trimEnd();
	return starred ? `${withoutStar} ⭐` : withoutStar;
}

export function addTaskTag(line: string, tag: string): string {
	const normalized = tag.trim().replace(/^#/, '').replace(/\s+/g, '-');
	if (!normalized) return line;
	const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	if (new RegExp(`(?:^|\\s)#${escaped}(?:/|\\s|$)`, 'u').test(line)) return line;
	return `${line.trimEnd()} #${normalized}`;
}

export function removeTaskTag(line: string, tag: string): string {
	const normalized = tag.trim().replace(/^#/, '');
	const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return mapTaskBody(line, (body) => body
		.replace(new RegExp(`\\s*#${escaped}(?:/\\S*)?(?=\\s|$)`, 'gu'), '')
		.replace(/\s{2,}/g, ' ')
		.trimEnd());
}

function comparableDocumentPath(path: string): string {
	return path.trim().replace(/^\/+/, '').replace(/\\/g, '/').replace(/\.md$/i, '');
}

function comparableDocumentPaths(path: string, equivalentPaths: Iterable<string>): Set<string> {
	return new Set([path, ...equivalentPaths].map(comparableDocumentPath));
}

export function addDocumentLink(line: string, path: string): string {
	const target = comparableDocumentPath(path);
	const exists = Array.from(line.matchAll(DOCUMENT_LINK_REGEX))
		.some((match) => comparableDocumentPath(match[1]) === target);
	return exists ? line : `${line.trimEnd()} 📄 [[${target}|任务内容]]`;
}

export function removeDocumentLink(
	line: string,
	path: string,
	equivalentPaths: Iterable<string> = [],
): string {
	const targets = comparableDocumentPaths(path, equivalentPaths);
	return mapTaskBody(line, (body) => body
		.replace(DOCUMENT_LINK_REGEX, (match, linkedPath: string) => (
			targets.has(comparableDocumentPath(linkedPath)) ? '' : match
		))
		.replace(/\s{2,}/g, ' ')
		.trimEnd());
}

export function replaceDocumentLink(
	line: string,
	oldPath: string,
	newPath: string,
	equivalentOldPaths: Iterable<string> = [],
): string {
	const oldTargets = comparableDocumentPaths(oldPath, equivalentOldPaths);
	const nextTarget = comparableDocumentPath(newPath);
	return mapTaskBody(line, (body) => body
		.replace(DOCUMENT_LINK_REGEX, (match, linkedPath: string) => (
			oldTargets.has(comparableDocumentPath(linkedPath))
				? ` 📄 [[${nextTarget}|任务内容]]`
				: match
		))
		.replace(/\s{2,}/g, ' ')
		.trimEnd());
}

export interface SuccessorTaskMetadata {
	line: string;
	childId: string;
}

export function ensureTaskId(line: string, candidateId: string): { line: string; taskId: string } {
	const existingTaskId = line.match(TASK_ID_REGEX)?.[1];
	const taskId = existingTaskId ?? candidateId;
	return {
		line: withTaskId(line, taskId),
		taskId,
	};
}

export function replaceTaskId(line: string, taskId: string): string {
	return TASK_ID_REGEX.test(line)
		? line.replace(TASK_ID_REGEX, `🆔 ${taskId}`)
		: withTaskId(line, taskId);
}

export function ensureSuccessorTaskMetadata(
	line: string,
	parentId: string,
	candidateChildId: string,
): SuccessorTaskMetadata {
	const child = ensureTaskId(line, candidateChildId);
	return {
		line: addDependency(child.line, parentId),
		childId: child.taskId,
	};
}
