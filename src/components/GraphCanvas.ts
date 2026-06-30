import { Menu, setIcon } from 'obsidian';
import {
	NodePosition,
	PositionedTaskNode,
	TaskEdge,
	ViewportState,
} from '../model/TaskGraphModel';
import { LayoutResult } from '../layout/LayeredLayout';

interface GraphCanvasOptions {
	onSelect: (node: PositionedTaskNode) => void;
	onOpen: (node: PositionedTaskNode) => void;
	onToggle: (node: PositionedTaskNode) => void;
	onEdit: (node: PositionedTaskNode) => void;
	onCreateSuccessor: (node: PositionedTaskNode, position?: NodePosition) => void;
	onCreatePredecessor: (node: PositionedTaskNode, position?: NodePosition) => void;
	onConnect: (parent: PositionedTaskNode, child: PositionedTaskNode) => void;
	onRemoveRelationship: (parent: PositionedTaskNode, child: PositionedTaskNode) => void;
	onDelete: (node: PositionedTaskNode) => void;
	onToggleStar: (node: PositionedTaskNode) => void;
	onNodeMove: (node: PositionedTaskNode, position: NodePosition) => void;
	onViewportChange: (viewport: ViewportState) => void;
	onCreateAt: (position: NodePosition) => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function statusLabel(node: PositionedTaskNode): string {
	if (node.readiness === 'ready') return '可开始';
	if (node.readiness === 'blocked') return `阻塞 ${node.unresolvedDependencyIds.length}`;
	if (node.readiness === 'active') return '进行中';
	return node.status === 'canceled' ? '已取消' : '当前任务已完成';
}

function priorityLabel(priority: PositionedTaskNode['priority']): string {
	switch (priority) {
		case 'highest': return '最高';
		case 'high': return '高';
		case 'medium': return '中';
		case 'low': return '低';
		case 'lowest': return '最低';
		default: return '';
	}
}

function fileName(path: string): string {
	const value = path.split('/').pop() ?? path;
	return value.replace(/\.md$/i, '');
}

export class GraphCanvas {
	private readonly hostEl: HTMLElement;
	private readonly viewportEl: HTMLElement;
	private readonly worldEl: HTMLElement;
	private readonly options: GraphCanvasOptions;
	private viewport: ViewportState = { x: 24, y: 24, scale: 1 };
	private layout: LayoutResult = { nodes: [], width: 0, height: 0 };
	private edges: TaskEdge[] = [];
	private selectedId: string | null = null;
	private isPanning = false;
	private panMoved = false;
	private panStart = { x: 0, y: 0, viewportX: 0, viewportY: 0 };
	private draggingNode: PositionedTaskNode | null = null;
	private dragCard: HTMLElement | null = null;
	private dragMoved = false;
	private dragStart = { x: 0, y: 0, nodeX: 0, nodeY: 0 };
	private connectionSource: PositionedTaskNode | null = null;
	private connectionCard: HTMLElement | null = null;
	private connectionPath: SVGPathElement | null = null;
	private connectionMoved = false;
	private connectionStart = { x: 0, y: 0 };
	private connectionHandle: 'source' | 'target' = 'source';

	constructor(hostEl: HTMLElement, options: GraphCanvasOptions) {
		this.hostEl = hostEl;
		this.options = options;
		this.hostEl.addClass('tgf-canvas');
		this.viewportEl = this.hostEl.createDiv('tgf-canvas-viewport');
		this.worldEl = this.viewportEl.createDiv('tgf-canvas-world');

		this.hostEl.addEventListener('wheel', this.handleWheel, { passive: false });
		this.hostEl.addEventListener('pointerdown', this.handlePointerDown);
		this.hostEl.addEventListener('contextmenu', this.handleContextMenu);
		window.addEventListener('pointermove', this.handlePointerMove);
		window.addEventListener('pointerup', this.handlePointerUp);
	}

	destroy(): void {
		this.hostEl.removeEventListener('wheel', this.handleWheel);
		this.hostEl.removeEventListener('pointerdown', this.handlePointerDown);
		this.hostEl.removeEventListener('contextmenu', this.handleContextMenu);
		window.removeEventListener('pointermove', this.handlePointerMove);
		window.removeEventListener('pointerup', this.handlePointerUp);
	}

	render(layout: LayoutResult, edges: TaskEdge[], selectedId: string | null): void {
		this.layout = layout;
		this.edges = edges;
		this.selectedId = selectedId;
		this.worldEl.empty();
		this.updateWorldSize();
		this.renderEdges();
		this.renderNodes();
		this.applyTransform();
	}

	setViewport(viewport: ViewportState): void {
		this.viewport = {
			x: viewport.x,
			y: viewport.y,
			scale: Math.min(2, Math.max(0.2, viewport.scale)),
		};
		this.applyTransform();
	}

	getViewport(): ViewportState {
		return { ...this.viewport };
	}

	getViewportCenter(): NodePosition {
		const rect = this.hostEl.getBoundingClientRect();
		return {
			x: Math.max(24, (rect.width / 2 - this.viewport.x) / this.viewport.scale),
			y: Math.max(24, (rect.height / 2 - this.viewport.y) / this.viewport.scale),
		};
	}

	setSelected(selectedId: string | null): void {
		this.selectedId = selectedId;
		this.worldEl.querySelectorAll('.tgf-node.is-selected').forEach((element) => {
			element.removeClass('is-selected');
		});
		if (selectedId) {
			const selected = this.worldEl.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(selectedId)}"]`);
			selected?.addClass('is-selected');
		}
	}

	fitView(): void {
		if (this.layout.nodes.length === 0) return;
		const rect = this.hostEl.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const bounds = this.getBounds();
		const width = Math.max(1, bounds.maxX - bounds.minX);
		const height = Math.max(1, bounds.maxY - bounds.minY);
		const scale = Math.min(
			1,
			Math.max(0.2, (rect.width - 56) / width),
			Math.max(0.2, (rect.height - 56) / height),
		);
		this.viewport = {
			scale,
			x: (rect.width - width * scale) / 2 - bounds.minX * scale,
			y: (rect.height - height * scale) / 2 - bounds.minY * scale,
		};
		this.applyTransform();
		this.options.onViewportChange(this.getViewport());
	}

	zoomBy(factor: number): void {
		const rect = this.hostEl.getBoundingClientRect();
		this.zoomAt(factor, rect.width / 2, rect.height / 2);
		this.options.onViewportChange(this.getViewport());
	}

	private getBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
		return this.layout.nodes.reduce((bounds, node) => ({
			minX: Math.min(bounds.minX, node.x),
			minY: Math.min(bounds.minY, node.y),
			maxX: Math.max(bounds.maxX, node.x + node.width),
			maxY: Math.max(bounds.maxY, node.y + node.height),
		}), {
			minX: Number.POSITIVE_INFINITY,
			minY: Number.POSITIVE_INFINITY,
			maxX: 0,
			maxY: 0,
		});
	}

	private updateWorldSize(): void {
		const maxX = Math.max(this.layout.width, ...this.layout.nodes.map((node) => node.x + node.width + 80), 800);
		const maxY = Math.max(this.layout.height, ...this.layout.nodes.map((node) => node.y + node.height + 80), 600);
		this.worldEl.style.width = `${maxX}px`;
		this.worldEl.style.height = `${maxY}px`;
	}

	private applyTransform(): void {
		const { x, y, scale } = this.viewport;
		this.worldEl.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
	}

	private zoomAt(factor: number, localX: number, localY: number): void {
		const previousScale = this.viewport.scale;
		const nextScale = Math.min(2, Math.max(0.2, previousScale * factor));
		const worldX = (localX - this.viewport.x) / previousScale;
		const worldY = (localY - this.viewport.y) / previousScale;
		this.viewport = {
			scale: nextScale,
			x: localX - worldX * nextScale,
			y: localY - worldY * nextScale,
		};
		this.applyTransform();
	}

	private handleWheel = (event: WheelEvent): void => {
		event.preventDefault();
		const rect = this.hostEl.getBoundingClientRect();
		this.zoomAt(
			event.deltaY < 0 ? 1.1 : 0.9,
			event.clientX - rect.left,
			event.clientY - rect.top,
		);
		this.options.onViewportChange(this.getViewport());
	};

	private handlePointerDown = (event: PointerEvent): void => {
		if (event.button !== 0) return;
		const target = event.target as HTMLElement;
		const card = target.closest<HTMLElement>('.tgf-node');
		if (card && !target.closest('button, a, input')) {
			const node = this.layout.nodes.find((item) => item.id === card.dataset.nodeId);
			if (!node) return;
			this.draggingNode = node;
			this.dragCard = card;
			this.dragMoved = false;
			this.dragStart = {
				x: event.clientX,
				y: event.clientY,
				nodeX: node.x,
				nodeY: node.y,
			};
			card.addClass('is-dragging');
			event.preventDefault();
			return;
		}
		if (card) return;
		this.isPanning = true;
		this.panMoved = false;
		this.hostEl.addClass('is-panning');
		this.panStart = {
			x: event.clientX,
			y: event.clientY,
			viewportX: this.viewport.x,
			viewportY: this.viewport.y,
		};
	};

	private handlePointerMove = (event: PointerEvent): void => {
		if (this.connectionSource) {
			const deltaX = event.clientX - this.connectionStart.x;
			const deltaY = event.clientY - this.connectionStart.y;
			if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) this.connectionMoved = true;
			this.updateConnectionPreview(this.clientToWorld(event.clientX, event.clientY));
			return;
		}
		if (this.draggingNode && this.dragCard) {
			const deltaX = (event.clientX - this.dragStart.x) / this.viewport.scale;
			const deltaY = (event.clientY - this.dragStart.y) / this.viewport.scale;
			if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) this.dragMoved = true;
			this.draggingNode.x = Math.max(12, this.dragStart.nodeX + deltaX);
			this.draggingNode.y = Math.max(12, this.dragStart.nodeY + deltaY);
			this.dragCard.style.left = `${this.draggingNode.x}px`;
			this.dragCard.style.top = `${this.draggingNode.y}px`;
			this.updateWorldSize();
			this.renderEdges();
			return;
		}
		if (!this.isPanning) return;
		const deltaX = event.clientX - this.panStart.x;
		const deltaY = event.clientY - this.panStart.y;
		if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) this.panMoved = true;
		this.viewport.x = this.panStart.viewportX + deltaX;
		this.viewport.y = this.panStart.viewportY + deltaY;
		this.applyTransform();
	};

	private handlePointerUp = (event: PointerEvent): void => {
		if (this.connectionSource) {
			const source = this.connectionSource;
			const point = this.clientToWorld(event.clientX, event.clientY);
			const rect = this.hostEl.getBoundingClientRect();
			const releasedInsideCanvas = (
				event.clientX >= rect.left
				&& event.clientX <= rect.right
				&& event.clientY >= rect.top
				&& event.clientY <= rect.bottom
			);
			const releasedNodeEl = (event.target as Element | null)?.closest<HTMLElement>('.tgf-node');
			const releasedNode = releasedNodeEl
				? this.layout.nodes.find((node) => node.id === releasedNodeEl.dataset.nodeId)
				: null;
			const releasedOnPanel = (event.target as Element | null)?.closest(
				'.tgf-source-panel, .tgf-inspector',
			);
			const handle = this.connectionHandle;
			const shouldCreate = releasedInsideCanvas && !releasedOnPanel && !releasedNode;
			this.finishConnection();
			if (releasedNode && releasedNode.id !== source.id) {
				if (handle === 'source') this.options.onConnect(source, releasedNode);
				else this.options.onConnect(releasedNode, source);
			} else if (shouldCreate) {
				const position = this.connectionMoved
					? {
						x: Math.max(24, point.x),
						y: Math.max(24, point.y - 58),
					}
					: undefined;
				if (handle === 'source') this.options.onCreateSuccessor(source, position);
				else this.options.onCreatePredecessor(source, position);
			}
			return;
		}
		if (this.draggingNode) {
			const node = this.draggingNode;
			this.dragCard?.removeClass('is-dragging');
			if (this.dragMoved) this.options.onNodeMove(node, { x: node.x, y: node.y });
			this.draggingNode = null;
			this.dragCard = null;
			window.setTimeout(() => {
				this.dragMoved = false;
			}, 0);
		}
		if (this.isPanning && this.panMoved) this.options.onViewportChange(this.getViewport());
		this.isPanning = false;
		this.hostEl.removeClass('is-panning');
	};

	private clientToWorld(clientX: number, clientY: number): NodePosition {
		const rect = this.hostEl.getBoundingClientRect();
		return {
			x: (clientX - rect.left - this.viewport.x) / this.viewport.scale,
			y: (clientY - rect.top - this.viewport.y) / this.viewport.scale,
		};
	}

	private startConnection(
		event: PointerEvent,
		node: PositionedTaskNode,
		card: HTMLElement,
		handle: 'source' | 'target',
	): void {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		this.connectionSource = node;
		this.connectionCard = card;
		this.connectionHandle = handle;
		this.connectionMoved = false;
		this.connectionStart = { x: event.clientX, y: event.clientY };
		card.addClass('is-connecting');
		this.hostEl.addClass(
			'is-connecting',
			handle === 'source' ? 'is-connecting-forward' : 'is-connecting-backward',
		);

		const edgeLayer = this.worldEl.querySelector<SVGSVGElement>('.tgf-edge-layer');
		if (!edgeLayer) return;
		const path = document.createElementNS(SVG_NS, 'path');
		path.addClass('tgf-edge', 'tgf-edge-preview');
		path.setAttribute('marker-end', 'url(#tgf-arrow)');
		edgeLayer.appendChild(path);
		this.connectionPath = path;
		this.updateConnectionPreview(this.clientToWorld(event.clientX, event.clientY));
	}

	private updateConnectionPreview(target: NodePosition): void {
		if (!this.connectionSource || !this.connectionPath) return;
		const portOffset = 8;
		const startX = this.connectionHandle === 'source'
			? this.connectionSource.x + this.connectionSource.width + portOffset
			: this.connectionSource.x - portOffset;
		const startY = this.connectionSource.y + this.connectionSource.height / 2;
		const distance = Math.max(52, Math.abs(target.x - startX) * 0.48);
		const direction = this.connectionHandle === 'source' ? 1 : -1;
		this.connectionPath.setAttribute(
			'd',
			`M ${startX} ${startY} C ${startX + direction * distance} ${startY}, ${target.x - direction * distance} ${target.y}, ${target.x} ${target.y}`,
		);
	}

	private finishConnection(): void {
		this.connectionPath?.remove();
		this.connectionCard?.removeClass('is-connecting');
		this.hostEl.removeClass('is-connecting', 'is-connecting-forward', 'is-connecting-backward');
		this.connectionSource = null;
		this.connectionCard = null;
		this.connectionPath = null;
		this.connectionMoved = false;
	}

	private handleContextMenu = (event: MouseEvent): void => {
		event.preventDefault();
		const card = (event.target as HTMLElement).closest<HTMLElement>('.tgf-node');
		const menu = new Menu();
		if (card) {
			const node = this.layout.nodes.find((item) => item.id === card.dataset.nodeId);
			if (!node) return;
			menu.addItem((item) => item.setTitle('创建后续任务').setIcon('git-branch-plus')
				.onClick(() => this.options.onCreateSuccessor(node)));
			menu.addItem((item) => item.setTitle('创建前置任务').setIcon('git-branch')
				.onClick(() => this.options.onCreatePredecessor(node)));
			menu.addItem((item) => item.setTitle('编辑任务').setIcon('pencil')
				.onClick(() => this.options.onEdit(node)));
			menu.addItem((item) => item.setTitle(node.starred ? '取消星标' : '添加星标').setIcon('star')
				.onClick(() => this.options.onToggleStar(node)));
			menu.addItem((item) => item.setTitle('打开原文').setIcon('file-text')
				.onClick(() => this.options.onOpen(node)));
			menu.addSeparator();
			menu.addItem((item) => item.setTitle('删除任务').setIcon('trash-2')
				.onClick(() => this.options.onDelete(node)));
		} else {
			const rect = this.hostEl.getBoundingClientRect();
			const position = {
				x: Math.max(24, (event.clientX - rect.left - this.viewport.x) / this.viewport.scale),
				y: Math.max(24, (event.clientY - rect.top - this.viewport.y) / this.viewport.scale),
			};
			menu.addItem((item) => item.setTitle('新建任务').setIcon('plus')
				.onClick(() => this.options.onCreateAt(position)));
		}
		menu.showAtMouseEvent(event);
	};

	private renderEdges(): void {
		this.worldEl.querySelector('.tgf-edge-layer')?.remove();
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.addClass('tgf-edge-layer');
		const width = parseFloat(this.worldEl.style.width) || this.layout.width;
		const height = parseFloat(this.worldEl.style.height) || this.layout.height;
		svg.setAttribute('width', String(width));
		svg.setAttribute('height', String(height));
		svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

		const defs = document.createElementNS(SVG_NS, 'defs');
		const marker = document.createElementNS(SVG_NS, 'marker');
		marker.setAttribute('id', 'tgf-arrow');
		marker.setAttribute('viewBox', '0 0 10 10');
		marker.setAttribute('refX', '9');
		marker.setAttribute('refY', '5');
		marker.setAttribute('markerWidth', '7');
		marker.setAttribute('markerHeight', '7');
		marker.setAttribute('orient', 'auto-start-reverse');
		const arrow = document.createElementNS(SVG_NS, 'path');
		arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
		marker.appendChild(arrow);
		defs.appendChild(marker);
		svg.appendChild(defs);

		const nodeById = new Map(this.layout.nodes.map((node) => [node.id, node]));
		this.edges.filter((edge) => !edge.missing).forEach((edge) => {
			const source = nodeById.get(edge.sourceId);
			const target = nodeById.get(edge.targetId);
			if (!source || !target) return;
			const portOffset = 8;
			const startX = source.x + source.width + portOffset;
			const startY = source.y + source.height / 2;
			const endX = target.x - portOffset;
			const endY = target.y + target.height / 2;
			const distance = Math.max(52, Math.abs(endX - startX) * 0.48);
			const path = document.createElementNS(SVG_NS, 'path');
			path.addClass('tgf-edge', 'is-interactive');
			path.setAttribute('d', `M ${startX} ${startY} C ${startX + distance} ${startY}, ${endX - distance} ${endY}, ${endX} ${endY}`);
			path.setAttribute('marker-end', 'url(#tgf-arrow)');
			path.addEventListener('click', (event) => {
				event.stopPropagation();
				this.options.onRemoveRelationship(source, target);
			});
			svg.appendChild(path);
		});

		this.worldEl.prepend(svg);
	}

	private renderNodes(): void {
		const layer = this.worldEl.createDiv('tgf-node-layer');
		this.layout.nodes.forEach((node) => {
			const card = layer.createDiv({
				cls: `tgf-node is-${node.readiness}${node.warnings.length > 0 ? ' has-warning' : ''}`,
				attr: {
					'data-node-id': node.id,
					tabindex: '0',
					'aria-label': node.text,
				},
			});
			if (node.id === this.selectedId) card.addClass('is-selected');
			if (node.starred) card.addClass('is-starred');
			card.style.left = `${node.x}px`;
			card.style.top = `${node.y}px`;
			card.style.width = `${node.width}px`;
			card.style.height = `${node.height}px`;

			const inputHandle = card.createEl('button', {
				cls: 'tgf-node-input-handle',
				attr: {
					'aria-label': '拖动以创建前置任务',
					title: '拖动到空白处创建前置任务',
				},
			});
			inputHandle.addEventListener('pointerdown', (event) => this.startConnection(event, node, card, 'target'));
			inputHandle.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
			});

			const outputHandle = card.createEl('button', {
				cls: 'tgf-node-output-handle',
				attr: {
					'aria-label': '拖动以创建后续任务',
					title: '拖动到空白处创建后续任务',
				},
			});
			outputHandle.addEventListener('pointerdown', (event) => this.startConnection(event, node, card, 'source'));
			outputHandle.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
			});

			card.createDiv({ cls: 'tgf-node-title', text: node.text });
			const meta = card.createDiv('tgf-node-meta');
			meta.createSpan({ text: fileName(node.path) });
			const date = node.dueDate ?? node.startDate ?? node.scheduledDate;
			if (date) meta.createSpan({ text: date });
			if (node.tags.length > 0) {
				const tagRow = card.createDiv('tgf-node-tags');
				node.tags.slice(0, 3).forEach((tag) => tagRow.createSpan({ text: `#${tag}` }));
			}

			const footer = card.createDiv('tgf-node-footer');
			const statusButton = footer.createEl('button', {
				cls: `tgf-status-pill is-${node.status} is-${node.readiness}`,
				attr: { 'aria-label': node.status === 'done' ? '标记为未完成' : '标记为已完成' },
			});
			statusButton.createSpan({ cls: 'tgf-status-dot' });
			statusButton.createSpan({ text: statusLabel(node) });
			statusButton.addEventListener('click', (event) => {
				event.stopPropagation();
				this.options.onToggle(node);
			});

			if (node.priority) {
				footer.createSpan({ cls: `tgf-priority is-${node.priority}`, text: priorityLabel(node.priority) });
			}
			if (node.warnings.length > 0) {
				const warning = footer.createSpan({ cls: 'tgf-warning', text: '!' });
				warning.setAttribute('aria-label', '任务关系需要检查');
			}

			const quickActions = footer.createDiv('tgf-node-quick-actions');
			const successor = quickActions.createEl('button', { attr: { title: '创建后续任务' } });
			setIcon(successor, 'git-branch-plus');
			successor.addEventListener('click', (event) => {
				event.stopPropagation();
				this.options.onCreateSuccessor(node);
			});
			const edit = quickActions.createEl('button', { attr: { title: '编辑任务' } });
			setIcon(edit, 'pencil');
			edit.addEventListener('click', (event) => {
				event.stopPropagation();
				this.options.onEdit(node);
			});
			const star = quickActions.createEl('button', {
				attr: { title: node.starred ? '取消星标' : '添加星标' },
			});
			setIcon(star, 'star');
			star.toggleClass('is-active', node.starred);
			star.addEventListener('click', (event) => {
				event.stopPropagation();
				this.options.onToggleStar(node);
			});

			card.addEventListener('click', () => {
				if (!this.dragMoved) this.options.onSelect(node);
			});
			card.addEventListener('dblclick', () => {
				if (!this.dragMoved) this.options.onOpen(node);
			});
			card.addEventListener('keydown', (event) => {
				if (event.key === 'Enter') this.options.onOpen(node);
			});
		});
	}
}
