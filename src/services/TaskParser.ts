import { TaskNode, TaskPriority, TaskStatus, TaskWarning } from '../model/TaskGraphModel';

const TASK_LINE_REGEX = /^(\s*(?:>\s*)*(?:[-*+]|\d+\.)\s+\[([^\]\r\n])\]\s+)(.*)$/;
const ID_REGEX = /🆔\s*([A-Za-z0-9_-]+)/;
const BLOCKED_BY_REGEX = /⛔\s*([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)/g;
const TAG_REGEX = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;
const DOCUMENT_LINK_REGEX = /(?:^|\s)📄\s*\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]*)?\]\]/gu;

export function normalizeDocumentPath(path: string): string {
	const trimmed = path.trim().replace(/^\/+/, '');
	return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}

export function readDocumentLinks(body: string): string[] {
	return Array.from(new Set(
		Array.from(body.matchAll(DOCUMENT_LINK_REGEX), (match) => normalizeDocumentPath(match[1])),
	));
}

export function hashText(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

export function taskPositionKey(
	task: Pick<TaskNode, 'stableId' | 'taskId' | 'path' | 'rawBody'>
		& { warnings?: TaskWarning[] },
): string {
	const duplicate = task.warnings?.includes('duplicate-id');
	return task.stableId && task.taskId && !duplicate
		? `id:${task.taskId}`
		: `task:${task.path}:${hashText(task.rawBody)}`;
}

function parseStatus(marker: string): TaskStatus {
	if (marker === 'x' || marker === 'X') {
		return 'done';
	}
	if (marker === '/') {
		return 'in_progress';
	}
	if (marker === '-') {
		return 'canceled';
	}
	return marker === ' ' ? 'todo' : 'custom';
}

function parsePriority(body: string): TaskPriority | undefined {
	if (body.includes('⏫')) return 'highest';
	if (body.includes('🔼')) return 'high';
	if (body.includes('🔺')) return 'medium';
	if (body.includes('🔽')) return 'low';
	if (body.includes('⏬')) return 'lowest';
	return undefined;
}

function readDate(body: string, emoji: string): string | undefined {
	const match = body.match(new RegExp(`${emoji}\\s*(\\d{4}-\\d{2}-\\d{2})`));
	return match?.[1];
}

function cleanTaskText(body: string): string {
	return body
		.replace(/🆔\s*[A-Za-z0-9_-]+/g, '')
		.replace(/⛔\s*[A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*/g, '')
		.replace(/(?:➕|🛫|⏳|📅|✅|❌)\s*\d{4}-\d{2}-\d{2}/gu, '')
		.replace(/(?:⏫|🔼|🔺|🔽|⏬)/gu, '')
		.replace(/(?:^|\s)⭐(?:\s|$)/gu, ' ')
		.replace(/(?:^|\s)#[\p{L}\p{N}_/-]+/gu, ' ')
		.replace(DOCUMENT_LINK_REGEX, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

export function parseTaskFile(path: string, content: string): TaskNode[] {
	const tasks: TaskNode[] = [];
	const headings: Array<{ level: number; text: string }> = [];
	const lines = content.split(/\r?\n/);

	lines.forEach((lineText, line) => {
		const headingMatch = lineText.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (headingMatch) {
			const level = headingMatch[1].length;
			while (headings.length > 0 && headings[headings.length - 1].level >= level) {
				headings.pop();
			}
			headings.push({ level, text: headingMatch[2] });
			return;
		}

		const taskMatch = lineText.match(TASK_LINE_REGEX);
		if (!taskMatch) {
			return;
		}

		const marker = taskMatch[2];
		const body = taskMatch[3].trim();
		if (!body) {
			return;
		}

		const stableId = body.match(ID_REGEX)?.[1];
		const blockedByIds = Array.from(new Set(
			Array.from(body.matchAll(BLOCKED_BY_REGEX))
				.flatMap((match) => match[1].split(',').map((id) => id.trim()))
				.filter(Boolean),
		));
		const tags = Array.from(body.matchAll(TAG_REGEX), (match) => match[1]);
		const internalId = `node-${hashText(`${path}:${line}:${body}`)}`;

		tasks.push({
			id: internalId,
			taskId: stableId,
			stableId: Boolean(stableId),
			text: cleanTaskText(body),
			rawBody: body,
			status: parseStatus(marker),
			statusMarker: marker,
			path,
			line,
			headingPath: headings.map((heading) => heading.text),
			tags,
			blockedByIds,
			priority: parsePriority(body),
			createdDate: readDate(body, '➕'),
			startDate: readDate(body, '🛫'),
			scheduledDate: readDate(body, '⏳'),
			dueDate: readDate(body, '📅'),
			completionDate: readDate(body, '✅'),
			starred: /(?:^|\s)⭐(?:\s|$)/u.test(body),
			documentLinks: readDocumentLinks(body),
		});
	});

	return tasks;
}
