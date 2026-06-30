import {
	DerivedTaskNode,
	TaskEdge,
	TaskGraphData,
	TaskNode,
	TaskWarning,
} from '../model/TaskGraphModel';

function findCycleIds(nodes: TaskNode[], edges: TaskEdge[]): Set<string> {
	const adjacency = new Map<string, string[]>();
	nodes.forEach((node) => adjacency.set(node.id, []));
	edges.filter((edge) => !edge.missing).forEach((edge) => {
		adjacency.get(edge.sourceId)?.push(edge.targetId);
	});

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const cycleIds = new Set<string>();
	const stack: string[] = [];

	const visit = (id: string): void => {
		if (visited.has(id)) return;
		if (visiting.has(id)) {
			const cycleStart = stack.indexOf(id);
			stack.slice(cycleStart).forEach((cycleId) => cycleIds.add(cycleId));
			return;
		}
		visiting.add(id);
		stack.push(id);
		(adjacency.get(id) ?? []).forEach(visit);
		stack.pop();
		visiting.delete(id);
		visited.add(id);
	};

	nodes.forEach((node) => visit(node.id));
	return cycleIds;
}

export function buildTaskGraph(tasks: TaskNode[]): TaskGraphData {
	const idCounts = new Map<string, number>();
	tasks.forEach((task) => {
		if (task.taskId) idCounts.set(task.taskId, (idCounts.get(task.taskId) ?? 0) + 1);
	});
	const nodeByTaskId = new Map<string, TaskNode>();
	tasks.forEach((task) => {
		if (task.taskId && idCounts.get(task.taskId) === 1) nodeByTaskId.set(task.taskId, task);
	});
	const edges: TaskEdge[] = [];
	const dependents = new Map<string, string[]>();

	tasks.forEach((task) => {
		task.blockedByIds.forEach((dependencyId) => {
			const dependency = nodeByTaskId.get(dependencyId);
			const missing = !dependency;
			edges.push({
				id: `${dependencyId}->${task.id}`,
				sourceId: dependency?.id ?? `missing-${dependencyId}`,
				targetId: task.id,
				missing,
			});
			if (dependency) {
				const current = dependents.get(dependency.id) ?? [];
				current.push(task.id);
				dependents.set(dependency.id, current);
			}
		});
	});

	const cycleIds = findCycleIds(tasks, edges);
	const nodes: DerivedTaskNode[] = tasks.map((task) => {
		const warnings: TaskWarning[] = [];
		if (!task.stableId && task.blockedByIds.length > 0) warnings.push('missing-id');
		if (task.taskId && (idCounts.get(task.taskId) ?? 0) > 1) warnings.push('duplicate-id');
		if (task.blockedByIds.some((id) => !nodeByTaskId.has(id))) warnings.push('missing-reference');
		if (cycleIds.has(task.id)) warnings.push('cycle');

		const unresolvedDependencyIds = task.blockedByIds.filter((dependencyId) => {
			const dependency = nodeByTaskId.get(dependencyId);
			return !dependency || (dependency.status !== 'done' && dependency.status !== 'canceled');
		});

		const readiness =
			task.status === 'done' || task.status === 'canceled'
				? 'finished'
				: task.status === 'in_progress'
					? 'active'
					: unresolvedDependencyIds.length > 0
						? 'blocked'
						: 'ready';

		return {
			...task,
			readiness,
			unresolvedDependencyIds,
			dependentIds: dependents.get(task.id) ?? [],
			warnings,
		};
	});

	return { nodes, edges };
}
