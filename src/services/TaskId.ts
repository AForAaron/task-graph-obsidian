export function createTaskId(existingIds: Iterable<string> = []): string {
	const existing = new Set(existingIds);
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const id = Array.from(
			{ length: 6 },
			() => Math.floor(Math.random() * 36).toString(36),
		).join('');
		if (!existing.has(id)) return id;
	}
	throw new Error('无法生成唯一任务 ID，请检查地图中是否存在大量重复 ID');
}
