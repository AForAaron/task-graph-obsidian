export async function runSuccessorWriteTransaction(
	writeParent: (() => Promise<void>) | null,
	writeChild: () => Promise<void>,
	rollbackParent: (() => Promise<void>) | null,
): Promise<void> {
	let parentWritten = false;
	if (writeParent) {
		await writeParent();
		parentWritten = true;
	}
	try {
		await writeChild();
	} catch (error) {
		if (parentWritten && rollbackParent) await rollbackParent();
		throw error;
	}
}
