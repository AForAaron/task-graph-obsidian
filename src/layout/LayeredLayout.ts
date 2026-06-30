import { DerivedTaskNode, PositionedTaskNode, TaskEdge } from '../model/TaskGraphModel';

const NODE_WIDTH = 224;
const NODE_HEIGHT = 116;
const COLUMN_GAP = 104;
const ROW_GAP = 34;
const PADDING = 72;
const ISOLATED_COLUMNS = 3;

export interface LayoutResult {
	nodes: PositionedTaskNode[];
	width: number;
	height: number;
}

function compareTaskOrder(a: DerivedTaskNode, b: DerivedTaskNode): number {
	if (a.createdDate && b.createdDate && a.createdDate !== b.createdDate) {
		return a.createdDate.localeCompare(b.createdDate);
	}
	if (a.createdDate !== b.createdDate) return a.createdDate ? -1 : 1;
	return a.path.localeCompare(b.path, 'zh-CN') || a.line - b.line;
}

export function layoutGraph(nodes: DerivedTaskNode[], edges: TaskEdge[]): LayoutResult {
	if (nodes.length === 0) return { nodes: [], width: 800, height: 600 };
	const visibleIds = new Set(nodes.map((node) => node.id));
	const validEdges = edges.filter((edge) => (
		!edge.missing && visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId)
	));
	const relatedIds = new Set<string>();
	validEdges.forEach((edge) => {
		relatedIds.add(edge.sourceId);
		relatedIds.add(edge.targetId);
	});
	const connected = nodes.filter((node) => relatedIds.has(node.id));
	const isolated = nodes
		.filter((node) => !relatedIds.has(node.id))
		.sort(compareTaskOrder);
	const cycleIds = new Set(nodes.filter((node) => node.warnings.includes('cycle')).map((node) => node.id));

	const incoming = new Map<string, string[]>();
	connected.forEach((node) => incoming.set(node.id, []));
	validEdges
		.filter((edge) => !cycleIds.has(edge.sourceId) && !cycleIds.has(edge.targetId))
		.forEach((edge) => incoming.get(edge.targetId)?.push(edge.sourceId));

	const layerById = new Map<string, number>();
	const resolveLayer = (id: string): number => {
		const existing = layerById.get(id);
		if (existing !== undefined) return existing;
		const dependencies = incoming.get(id) ?? [];
		const layer = dependencies.length === 0
			? 0
			: Math.max(...dependencies.map((dependencyId) => resolveLayer(dependencyId))) + 1;
		layerById.set(id, layer);
		return layer;
	};
	connected.filter((node) => !cycleIds.has(node.id)).forEach((node) => resolveLayer(node.id));
	const maxNormalLayer = Math.max(0, ...Array.from(layerById.values()));
	connected.filter((node) => cycleIds.has(node.id)).forEach((node) => {
		layerById.set(node.id, maxNormalLayer + 1);
	});

	const groups = new Map<number, DerivedTaskNode[]>();
	connected.forEach((node) => {
		const layer = layerById.get(node.id) ?? 0;
		const group = groups.get(layer) ?? [];
		group.push(node);
		groups.set(layer, group);
	});
	const branchOrderById = new Map<string, number>();
	Array.from(groups.keys())
		.sort((a, b) => a - b)
		.forEach((layer) => {
			const group = groups.get(layer)!;
			group.sort((a, b) => {
				const parentOrder = (node: DerivedTaskNode): number => {
					const orders = (incoming.get(node.id) ?? [])
						.map((parentId) => branchOrderById.get(parentId))
						.filter((order): order is number => order !== undefined);
					return orders.length > 0
						? orders.reduce((sum, order) => sum + order, 0) / orders.length
						: Number.MAX_SAFE_INTEGER;
				};
				const orderDifference = parentOrder(a) - parentOrder(b);
				return orderDifference || compareTaskOrder(a, b);
			});
			group.forEach((node, index) => branchOrderById.set(node.id, index));
		});

	const maxRows = Math.max(1, ...Array.from(groups.values(), (group) => group.length));
	const connectedHeight = connected.length === 0
		? 0
		: maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
	const positioned: PositionedTaskNode[] = [];

	groups.forEach((group, layer) => {
		const groupHeight = group.length * NODE_HEIGHT + Math.max(0, group.length - 1) * ROW_GAP;
		const startY = PADDING + (connectedHeight - groupHeight) / 2;
		group.forEach((node, index) => {
			positioned.push({
				...node,
				x: PADDING + layer * (NODE_WIDTH + COLUMN_GAP),
				y: startY + index * (NODE_HEIGHT + ROW_GAP),
				width: NODE_WIDTH,
				height: NODE_HEIGHT,
				layer,
			});
		});
	});

	const isolatedStartY = PADDING + connectedHeight + (connected.length > 0 && isolated.length > 0 ? 96 : 0);
	isolated.forEach((node, index) => {
		const column = index % ISOLATED_COLUMNS;
		const row = Math.floor(index / ISOLATED_COLUMNS);
		positioned.push({
			...node,
			x: PADDING + column * (NODE_WIDTH + COLUMN_GAP),
			y: isolatedStartY + row * (NODE_HEIGHT + ROW_GAP),
			width: NODE_WIDTH,
			height: NODE_HEIGHT,
			layer: -1,
		});
	});

	const maxX = Math.max(...positioned.map((node) => node.x + node.width));
	const maxY = Math.max(...positioned.map((node) => node.y + node.height));
	return {
		nodes: positioned,
		width: Math.max(800, maxX + PADDING),
		height: Math.max(600, maxY + PADDING),
	};
}
