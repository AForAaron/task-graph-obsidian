import { readFileSync } from 'fs';
import { parseTaskFile } from '../src/services/TaskParser';
import { buildTaskGraph } from '../src/services/GraphBuilder';
import { layoutGraph } from '../src/layout/LayeredLayout';
import { migratePluginData, renamePathValue, renameSourcePaths } from '../src/services/PluginData';
import { taskPositionKey } from '../src/services/TaskParser';
import { resolveSourcePathRules } from '../src/services/SourceRules';
import { runSuccessorWriteTransaction } from '../src/services/WriteTransaction';
import {
	addDependency,
	addTaskTag,
	ensureTaskId,
	ensureSuccessorTaskMetadata,
	readDependencyIds,
	removeDependency,
	removeTaskTag,
	setTaskStarred,
} from '../src/services/TaskLineMetadata';
import { createTaskId } from '../src/services/TaskId';

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

const sample = [
	'- [ ] 项目根 🆔 root001',
	'- [ ] 设计界面 🆔 design01 ⛔ root001',
	'- [/] 开发画布 🆔 canvas01 ⛔ design01 🛫 2026-06-28',
	'- [x] 调研 ✅ 2026-06-27 🆔 research01',
].join('\n');

const sampleTasks = parseTaskFile('sample.md', sample);
assert(sampleTasks.length === 4, '应解析 4 个任务');
assert(sampleTasks[1].blockedByIds[0] === 'root001', '应解析阻塞关系');
assert(sampleTasks[2].status === 'in_progress', '应解析进行中状态');

const sampleGraph = buildTaskGraph(sampleTasks);
assert(sampleGraph.edges.length === 2, '应建立 2 条依赖边');
assert(sampleGraph.nodes.find((node) => node.taskId === 'root001')?.readiness === 'ready', '根任务应可开始');
assert(sampleGraph.nodes.find((node) => node.taskId === 'design01')?.readiness === 'blocked', '子任务应被阻塞');
assert(sampleGraph.nodes.find((node) => node.taskId === 'canvas01')?.readiness === 'active', '进行中任务应为 active');

const layout = layoutGraph(sampleGraph.nodes, sampleGraph.edges);
const root = layout.nodes.find((node) => node.taskId === 'root001');
const child = layout.nodes.find((node) => node.taskId === 'design01');
assert(Boolean(root && child && root.x < child.x), '前置任务应排在依赖任务左侧');

const orderedBranchTasks = parseTaskFile('ordered-branch.md', [
	'- [ ] 父任务 🆔 parent01',
	'- [ ] 后创建但行号靠前的分支 ➕ 2026-06-28 🆔 branch02 ⛔ parent01',
	'- [ ] 后创建分支的子任务 ➕ 2026-06-28 🆔 child002 ⛔ branch02',
	'- [ ] 先创建但行号靠后的分支 ➕ 2026-06-26 🆔 branch01 ⛔ parent01',
	'- [ ] 先创建分支的子任务 ➕ 2026-06-29 🆔 child001 ⛔ branch01',
].join('\n'));
const orderedBranchGraph = buildTaskGraph(orderedBranchTasks);
const orderedBranchLayout = layoutGraph(orderedBranchGraph.nodes, orderedBranchGraph.edges);
const firstBranch = orderedBranchLayout.nodes.find((node) => node.taskId === 'branch01');
const secondBranch = orderedBranchLayout.nodes.find((node) => node.taskId === 'branch02');
assert(
	Boolean(firstBranch && secondBranch && firstBranch.y < secondBranch.y),
	'同一父任务的后创建分支应排在已有分支下方',
);
const firstBranchChild = orderedBranchLayout.nodes.find((node) => node.taskId === 'child001');
const secondBranchChild = orderedBranchLayout.nodes.find((node) => node.taskId === 'child002');
assert(
	Boolean(firstBranchChild && secondBranchChild && firstBranchChild.y < secondBranchChild.y),
	'子节点应继承父分支的上下顺序，避免跨分支连线交叉',
);

const isolated = layout.nodes.find((node) => node.taskId === 'research01');
assert(Boolean(isolated && isolated.layer === -1), '无关联任务应进入独立网格区域');

const cycleTasks = parseTaskFile('cycle.md', [
	'- [ ] A 🆔 aaa ⛔ bbb',
	'- [ ] B 🆔 bbb ⛔ aaa',
].join('\n'));
const cycleGraph = buildTaskGraph(cycleTasks);
assert(cycleGraph.nodes.every((node) => node.warnings.includes('cycle')), '应识别循环依赖');
const cycleLayout = layoutGraph(cycleGraph.nodes, cycleGraph.edges);
assert(cycleLayout.nodes[0].layer === cycleLayout.nodes[1].layer, '循环依赖应集中在同一布局层');

const migrated = migratePluginData({
	lastScopePath: 'Projects/Launch.md',
	showCompleted: false,
});
assert(migrated.version === 2, '旧数据应迁移到 v2');
assert(migrated.maps.length === 1, '旧范围应迁移为一张地图');
assert(migrated.maps[0].sources[0]?.path === 'Projects/Launch.md', '旧文件范围应成为地图来源');
assert(migrated.showCompleted === false, '旧显示设置应保留');

const firstPositionKey = taskPositionKey(sampleTasks[0]);
assert(firstPositionKey === 'id:root001', '有 ID 任务应使用 ID 位置键');
const noIdTask = parseTaskFile('sample.md', '- [ ] 没有 ID 的任务')[0];
assert(taskPositionKey(noIdTask).startsWith('task:sample.md:'), '无 ID 任务应使用路径和内容指纹');

const renamedMaps = migrated.maps;
renamedMaps[0].sources.push({ type: 'folder', path: 'Projects/Area', recursive: true });
renamedMaps[0].nodePositions['task:Projects/Area/Plan.md:abc'] = { x: 10, y: 20 };
assert(renameSourcePaths(renamedMaps, 'Projects/Area', 'Archive/Area'), '来源重命名应报告变化');
assert(renamedMaps[0].sources[1].path === 'Archive/Area', '文件夹来源路径应随重命名更新');
assert(Boolean(renamedMaps[0].nodePositions['task:Archive/Area/Plan.md:abc']), '无 ID 布局键应随路径迁移');
assert(
	renamePathValue('Projects/Area/Nested/Plan.md', 'Projects/Area', 'Archive/Area')
		=== 'Archive/Area/Nested/Plan.md',
	'当前文件和展开目录路径应随文件夹重命名迁移',
);
assert(
	renamePathValue('Projects/Area-old/Plan.md', 'Projects/Area', 'Archive/Area')
		=== 'Projects/Area-old/Plan.md',
	'重命名迁移必须遵守路径边界',
);

const sourceResolution = resolveSourcePathRules([
	{ type: 'folder', path: 'Projects', recursive: true },
	{ type: 'file', path: 'Projects/Plan.md' },
	{ type: 'file', path: 'Missing.md' },
], [
	'Projects/Plan.md',
	'Projects/Nested/Build.md',
	'Unselected.md',
], ['Projects', 'Projects/Nested']);
assert(sourceResolution.filePaths.length === 2, '递归文件夹与重叠文件来源应去重');
assert(sourceResolution.filePaths.includes('Projects/Nested/Build.md'), '文件夹来源应递归包含子目录');
assert(!sourceResolution.filePaths.includes('Unselected.md'), '未选择的文件不应进入地图');
assert(sourceResolution.missing[0]?.path === 'Missing.md', '删除的来源应保留为缺失配置');

const successorMetadata = ensureSuccessorTaskMetadata('- [ ] 后续任务', 'parent01', 'child01');
assert(successorMetadata.line.includes('🆔 child01'), '后续任务应自动获得独立任务 ID');
assert(successorMetadata.line.includes('⛔ parent01'), '后续任务应保留父任务依赖');
const existingSuccessorMetadata = ensureSuccessorTaskMetadata(
	'- [ ] 已有 ID 🆔 existing01 ⛔ parent01',
	'parent01',
	'ignored01',
);
assert(existingSuccessorMetadata.childId === 'existing01', '已有子任务 ID 不应被覆盖');
assert((existingSuccessorMetadata.line.match(/🆔/g) ?? []).length === 1, '不应重复写入子任务 ID');

const csvLine = addDependency('- [ ] 多前置 🆔 child1 ⛔ root1', 'root2');
assert(csvLine.includes('⛔ root1,root2'), '新增关系应统一写为 CSV 依赖');
assert(readDependencyIds('- [ ] 混合 ⛔ root1, root2 ⛔ root3').join(',') === 'root1,root2,root3', '应读取 CSV 与独立依赖');
assert(removeDependency(csvLine, 'root1').includes('⛔ root2'), '应只移除指定关系');
assert(!removeDependency(csvLine, 'root1').includes('root1'), '已移除的关系不应残留');

const independentGraph = buildTaskGraph(parseTaskFile('independent.md', '- [ ] 独立任务'));
assert(!independentGraph.nodes[0].warnings.includes('missing-id'), '独立无 ID 任务不应警告');
const missingRelationGraph = buildTaskGraph(parseTaskFile('relation.md', '- [ ] 关系任务 ⛔ parent1'));
assert(missingRelationGraph.nodes[0].warnings.includes('missing-id'), '参与关系的无 ID 任务应警告');

const duplicateGraph = buildTaskGraph(parseTaskFile('duplicate.md', [
	'- [ ] 重复 A 🆔 same01',
	'- [ ] 重复 B 🆔 same01',
].join('\n')));
assert(duplicateGraph.nodes.every((node) => node.warnings.includes('duplicate-id')), '重复 ID 应在每个任务上警告');
assert(new Set(duplicateGraph.nodes.map((node) => node.id)).size === 2, '重复任务 ID 不应覆盖内部节点');

const generatedId = createTaskId(['aaaaaa']);
assert(/^[a-z0-9]{6}$/.test(generatedId), '自动 ID 应为 Tasks Map 兼容的 6 位小写字母数字');
const preparedTask = ensureTaskId('- [ ] 普通新任务', 'new001');
assert(preparedTask.line.includes('🆔 new001'), '普通新任务也应自动写入 ID');
assert(setTaskStarred('- [ ] 星标任务', true).endsWith('⭐'), '应写入标准星标');
assert(!setTaskStarred('- [ ] 星标任务 ⭐', false).includes('⭐'), '应移除标准星标');
const tagged = addTaskTag('- [ ] 标签任务', '#设计');
assert(tagged.endsWith('#设计'), '应写入标准标签');
assert(!removeTaskTag(tagged, '设计').includes('#设计'), '应移除指定标签');

async function testSuccessorRollback(): Promise<void> {
	const events: string[] = [];
	let failed = false;
	try {
		await runSuccessorWriteTransaction(
			async () => { events.push('parent'); },
			async () => {
				events.push('child');
				throw new Error('write failed');
			},
			async () => { events.push('rollback'); },
		);
	} catch {
		failed = true;
	}
	assert(failed, '子任务写入失败应向上传递错误');
	assert(events.join(',') === 'parent,child,rollback', '子任务失败后应回滚父任务 ID');
}

const targetPath = process.argv[2];
if (targetPath) {
	const actualTasks = parseTaskFile(targetPath, readFileSync(targetPath, 'utf8'));
	const actualGraph = buildTaskGraph(actualTasks);
	console.log(JSON.stringify({
		file: targetPath,
		tasks: actualTasks.length,
		edges: actualGraph.edges.filter((edge) => !edge.missing).length,
		ready: actualGraph.nodes.filter((node) => node.readiness === 'ready').length,
		blocked: actualGraph.nodes.filter((node) => node.readiness === 'blocked').length,
		active: actualGraph.nodes.filter((node) => node.readiness === 'active').length,
		warnings: actualGraph.nodes.filter((node) => node.warnings.length > 0).length,
	}, null, 2));
}

void testSuccessorRollback().then(() => {
	console.log('Task Graph smoke test passed.');
});
