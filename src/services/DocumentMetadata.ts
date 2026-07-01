export const CONTENT_FOLDER_NAME = '任务内容';

export function documentPositionKey(path: string): string {
	return `doc:${path}`;
}

export function documentTitle(path: string): string {
	return (path.split('/').pop() ?? path).replace(/\.md$/i, '');
}

export function sanitizeDocumentTitle(value: string): string {
	return value
		.trim()
		.replace(/[\\/:*?"<>|#^[\]]/g, '-')
		.replace(/\s+/g, ' ')
		.replace(/^\.+|\.+$/g, '')
		.slice(0, 80) || '未命名内容';
}

export function contentFolderForFile(path: string): string {
	const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	return parent ? `${parent}/${CONTENT_FOLDER_NAME}` : CONTENT_FOLDER_NAME;
}

export function calculateDocumentStats(content: string): {
	excerpt: string;
	wordCount: number;
	checklistDone: number;
	checklistTotal: number;
} {
	const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
	const checklistMatches = Array.from(body.matchAll(/^\s*(?:[-*+]|\d+\.)\s+\[([ xX/\-])\]\s+/gm));
	const checklistDone = checklistMatches.filter((match) => match[1].toLowerCase() === 'x').length;
	const plain = body
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`[^`]*`/g, ' ')
		.replace(/!?\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)/g, ' ')
		.replace(/^\s{0,3}#{1,6}\s+/gm, '')
		.replace(/^\s*(?:[-*+]|\d+\.)\s+\[[ xX/\-]\]\s+/gm, '')
		.replace(/[*_~>#-]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const cjk = plain.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
	const latinWords = plain
		.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ')
		.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
	const excerpt = body
		.replace(/^\s{0,3}#{1,6}\s+.*$/gm, '')
		.replace(/^\s*(?:[-*+]|\d+\.)\s+\[[ xX/\-]\]\s+/gm, '')
		.replace(/!?\[\[([^\]]+)\]\]/g, '$1')
		.replace(/[*_~>#`-]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 180);
	return {
		excerpt,
		wordCount: cjk + latinWords,
		checklistDone,
		checklistTotal: checklistMatches.length,
	};
}
