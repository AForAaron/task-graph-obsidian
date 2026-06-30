import {
	ItemView,
	MarkdownView,
	Notice,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
	setIcon,
} from 'obsidian';
import TaskGraphPlugin from '../main';
import { GraphCanvas } from '../components/GraphCanvas';
import {
	chooseTaskTarget,
	confirmAction,
	openSourcePicker,
	renderSourceTree,
	requestMapName,
	requestTextValue,
	TaskTarget,
} from '../components/TaskGraphModals';
import {
	DerivedTaskNode,
	MapSource,
	NodePosition,
	PositionedTaskNode,
	TaskGraphData,
	TaskMapConfig,
	TaskNode,
	TaskStatus,
	ViewportState,
	createTaskMap,
} from '../model/TaskGraphModel';
import { parseTaskFile, taskPositionKey } from '../services/TaskParser';
import { buildTaskGraph } from '../services/GraphBuilder';
import { LayoutResult, layoutGraph } from '../layout/LayeredLayout';
import {
	mapContainsPath,
	resolveMapSources,
	toggleSource,
} from '../services/MapSourceResolver';
import { getTasksApi } from '../services/TasksApi';
import { renamePathValue } from '../services/PluginData';
import { ensureTaskId, replaceTaskId } from '../services/TaskLineMetadata';
import {
	appendTaskLine,
	assignTaskId,
	changeTaskTag,
	connectTasks,
	createPredecessorTask,
	createSuccessorTask,
	createTaskId,
	deleteTaskAndReferences,
	findTaskLine,
	markTaskInProgress,
	normalizeTaskLine,
	prepareNewTaskLine,
	removeTaskRelationship,
	repairTaskIds,
	replaceTaskLine,
	setTaskStar,
} from '../services/TaskWriter';

export const TASK_GRAPH_VIEW = 'task-graph-view';

const STATUS_LABELS: Record<TaskStatus, string> = {
	todo: '待办',
	in_progress: '进行中',
	done: '已完成',
	canceled: '已取消',
};

export class TaskGraphView extends ItemView {
	private readonly plugin: TaskGraphPlugin;
	private graphCanvas: GraphCanvas | null = null;
	private toolbarEl: HTMLElement;
	private sourcePanelEl: HTMLElement;
	private sourceSummaryEl: HTMLElement;
	private sourceTreeEl: HTMLElement;
	private currentFileEl: HTMLElement;
	private inspectorEl: HTMLElement;
	private statusBarEl: HTMLElement;
	private mapSelectEl: HTMLSelectElement;
	private searchInputEl: HTMLInputElement;
	private sourceSearchEl: HTMLInputElement;
	private collapseButton: HTMLButtonElement;
	private taskCache = new Map<string, TaskNode[]>();
	private graphData: TaskGraphData = { nodes: [], edges: [] };
	private currentFilePath = '';
	private selectedId: string | null = null;
	private searchQuery = '';
	private sourceQuery = '';
	private enabledStatuses = new Set<TaskStatus>(['todo', 'in_progress', 'done', 'canceled']);
	private refreshTimer: number | null = null;
	private saveTimer: number | null = null;
	private shouldFitAfterRender = false;
	private expandedSourceFolders = new Set<string>();

	constructor(leaf: WorkspaceLeaf, plugin: TaskGraphPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return TASK_GRAPH_VIEW;
	}

	getDisplayText(): string {
		return 'Task Graph';
	}

	getIcon(): string {
		return 'git-fork';
	}

	private get activeMap(): TaskMapConfig {
		return this.plugin.getActiveMap();
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('tgf-container');
		this.toolbarEl = this.contentEl.createDiv('tgf-toolbar');
		const body = this.contentEl.createDiv('tgf-body');
		this.sourcePanelEl = body.createEl('aside', { cls: 'tgf-source-panel' });
		const canvasHost = body.createDiv('tgf-canvas-host');
		this.inspectorEl = body.createEl('aside', { cls: 'tgf-inspector' });
		this.statusBarEl = this.contentEl.createDiv('tgf-statusbar');

		this.buildToolbar();
		this.buildSourcePanel();
		this.graphCanvas = new GraphCanvas(canvasHost, {
			onSelect: (node) => this.selectNode(node),
			onOpen: (node) => void this.openTask(node),
			onToggle: (node) => void this.toggleTask(node),
			onEdit: (node) => void this.editTask(node),
			onCreateSuccessor: (node, position) => void this.createSuccessor(node, position),
			onCreatePredecessor: (node, position) => void this.createPredecessor(node, position),
			onConnect: (parent, child) => void this.connectNodes(parent, child),
			onRemoveRelationship: (parent, child) => void this.removeRelationship(parent, child),
			onDelete: (node) => void this.deleteTask(node),
			onToggleStar: (node) => void this.toggleStar(node),
			onNodeMove: (node, position) => this.saveNodePosition(node, position),
			onViewportChange: (viewport) => this.saveViewport(viewport),
			onCreateAt: (position) => void this.createTask(undefined, position),
		});

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file instanceof TFile && file.extension === 'md' && mapContainsPath(this.activeMap, file.path)) {
				this.scheduleReload();
			}
		}));
		this.registerEvent(this.app.vault.on('delete', () => this.scheduleReload()));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			this.handleRenamedPath(oldPath, file.path);
			this.scheduleReload();
		}));
		this.registerEvent(this.app.vault.on('create', (file) => {
			if (file instanceof TFile && file.extension === 'md' && mapContainsPath(this.activeMap, file.path)) {
				this.scheduleReload();
			}
		}));

		await this.reloadMap();
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			await this.plugin.persistData();
		}
		this.graphCanvas?.destroy();
	}

	private buildToolbar(): void {
		const primary = this.toolbarEl.createDiv('tgf-toolbar-row tgf-toolbar-primary');
		const secondary = this.toolbarEl.createDiv('tgf-toolbar-row tgf-toolbar-secondary');
		const brand = primary.createDiv('tgf-brand');
		const brandIcon = brand.createSpan('tgf-brand-icon');
		setIcon(brandIcon, 'git-fork');
		const brandText = brand.createDiv();
		brandText.createDiv({ cls: 'tgf-brand-title', text: 'Task Graph' });
		brandText.createDiv({ cls: 'tgf-brand-subtitle', text: '可编辑任务地图' });

		const mapField = primary.createDiv('tgf-map-field');
		this.mapSelectEl = mapField.createEl('select', { cls: 'dropdown' });
		this.mapSelectEl.addEventListener('change', () => void this.switchMap(this.mapSelectEl.value));
		this.createIconButton(mapField, 'plus', '新建地图', () => void this.createMap());
		this.createIconButton(mapField, 'pencil', '重命名地图', () => void this.renameMap());
		this.createIconButton(mapField, 'trash-2', '删除地图', () => void this.deleteMap());

		const primaryActions = primary.createDiv('tgf-primary-actions');
		this.createTextButton(primaryActions, 'folder-cog', '来源', () => void this.manageSources());
		this.createTextButton(primaryActions, 'plus', '新建任务', () => void this.createTask());
		this.createTextButton(primaryActions, 'layout-dashboard', '规整', () => void this.organizeGraph());

		const searchField = secondary.createDiv('tgf-search');
		const searchIcon = searchField.createSpan('tgf-search-icon');
		setIcon(searchIcon, 'search');
		this.searchInputEl = searchField.createEl('input', {
			type: 'search',
			placeholder: '搜索任务、标签或 ID',
		});
		this.searchInputEl.addEventListener('input', () => {
			this.searchQuery = this.searchInputEl.value.trim().toLocaleLowerCase();
			this.renderGraph();
		});

		const statusGroup = secondary.createDiv('tgf-status-filter');
		(['todo', 'in_progress', 'done'] as TaskStatus[]).forEach((status) => {
			const button = statusGroup.createEl('button', {
				cls: 'tgf-filter-chip is-active',
				text: STATUS_LABELS[status],
			});
			button.addEventListener('click', () => {
				if (this.enabledStatuses.has(status)) {
					this.enabledStatuses.delete(status);
					button.removeClass('is-active');
				} else {
					this.enabledStatuses.add(status);
					button.addClass('is-active');
				}
				this.renderGraph();
			});
		});

		const actions = secondary.createDiv('tgf-toolbar-actions');
		this.createIconButton(actions, 'minus', '缩小', () => this.graphCanvas?.zoomBy(0.85));
		this.createIconButton(actions, 'plus', '放大', () => this.graphCanvas?.zoomBy(1.15));
		this.createIconButton(actions, 'scan', '适应画布', () => this.graphCanvas?.fitView());
		this.createIconButton(actions, 'refresh-cw', '重新读取任务', () => void this.reloadMap());
		this.populateMapOptions();
	}

	private buildSourcePanel(): void {
		const header = this.sourcePanelEl.createDiv('tgf-panel-header');
		const title = header.createDiv();
		title.createDiv({ cls: 'tgf-panel-title', text: '来源与任务' });
		title.createDiv({ cls: 'tgf-panel-subtitle', text: '勾选地图内容，点击文件设为当前文件' });
		this.collapseButton = this.createIconButton(header, 'panel-left-close', '折叠来源面板', () => {
			this.plugin.data.sourcePanelCollapsed = !this.plugin.data.sourcePanelCollapsed;
			this.applyPanelCollapsed();
			this.queueSave();
		});

		const searchWrap = this.sourcePanelEl.createDiv('tgf-source-search');
		setIcon(searchWrap.createSpan(), 'search');
		this.sourceSearchEl = searchWrap.createEl('input', {
			type: 'search',
			placeholder: '搜索 Vault 文件树',
		});
		this.sourceSearchEl.addEventListener('input', () => {
			this.sourceQuery = this.sourceSearchEl.value;
			this.renderSourcePanel();
		});
		this.sourceSummaryEl = this.sourcePanelEl.createDiv('tgf-source-summary');
		const treeHeading = this.sourcePanelEl.createDiv('tgf-source-tree-heading');
		treeHeading.createSpan({ text: 'Vault 文件树' });
		treeHeading.createSpan({ text: '勾选来源 · 点击文件切换' });
		this.sourceTreeEl = this.sourcePanelEl.createDiv('tgf-source-tree');
		this.currentFileEl = this.sourcePanelEl.createDiv('tgf-current-file');
		this.applyPanelCollapsed();
	}

	private createIconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLButtonElement {
		const button = parent.createEl('button', {
			cls: 'tgf-icon-button',
			attr: { 'aria-label': label, title: label },
		});
		setIcon(button, icon);
		button.addEventListener('click', onClick);
		return button;
	}

	private createTextButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLButtonElement {
		const button = parent.createEl('button', { cls: 'tgf-text-button' });
		setIcon(button.createSpan(), icon);
		button.createSpan({ text: label });
		button.addEventListener('click', onClick);
		return button;
	}

	private applyPanelCollapsed(): void {
		const collapsed = this.plugin.data.sourcePanelCollapsed;
		this.sourcePanelEl.toggleClass('is-collapsed', collapsed);
		this.collapseButton?.empty();
		if (this.collapseButton) setIcon(this.collapseButton, collapsed ? 'panel-left-open' : 'panel-left-close');
	}

	private handleRenamedPath(oldPath: string, newPath: string): void {
		this.currentFilePath = renamePathValue(this.currentFilePath, oldPath, newPath);
		this.expandedSourceFolders = new Set(Array.from(this.expandedSourceFolders, (path) => (
			renamePathValue(path, oldPath, newPath)
		)));
	}

	private populateMapOptions(): void {
		if (!this.mapSelectEl) return;
		this.mapSelectEl.empty();
		this.plugin.data.maps.forEach((map) => {
			this.mapSelectEl.createEl('option', { value: map.id, text: map.name });
		});
		this.mapSelectEl.value = this.plugin.data.activeMapId;
	}

	private async createMap(): Promise<void> {
		const name = await requestMapName(this.app, '新建任务地图');
		if (!name) return;
		const map = createTaskMap(name);
		this.plugin.data.maps.push(map);
		this.plugin.data.activeMapId = map.id;
		await this.plugin.persistData();
		this.populateMapOptions();
		await this.switchMap(map.id);
	}

	private async renameMap(): Promise<void> {
		const name = await requestMapName(this.app, '重命名任务地图', this.activeMap.name);
		if (!name) return;
		this.activeMap.name = name;
		await this.plugin.persistData();
		this.populateMapOptions();
	}

	private async deleteMap(): Promise<void> {
		if (this.plugin.data.maps.length === 1) {
			new Notice('至少需要保留一张任务地图');
			return;
		}
		const map = this.activeMap;
		const confirmed = await confirmAction(
			this.app,
			`删除“${map.name}”？`,
			'只会删除地图来源、布局和视口，不会删除任何笔记或任务。',
		);
		if (!confirmed) return;
		this.plugin.data.maps = this.plugin.data.maps.filter((item) => item.id !== map.id);
		this.plugin.data.activeMapId = this.plugin.data.maps[0].id;
		await this.plugin.persistData();
		this.populateMapOptions();
		await this.reloadMap();
	}

	private async switchMap(mapId: string): Promise<void> {
		if (!this.plugin.data.maps.some((map) => map.id === mapId)) return;
		this.plugin.data.activeMapId = mapId;
		this.selectedId = null;
		this.currentFilePath = '';
		await this.plugin.persistData();
		await this.reloadMap();
	}

	private async manageSources(): Promise<void> {
		const sources = await openSourcePicker(this.app, this.activeMap);
		if (!sources) return;
		this.activeMap.sources = sources;
		await this.plugin.persistData();
		await this.reloadMap();
	}

	private async reloadMap(): Promise<void> {
		this.populateMapOptions();
		const map = this.activeMap;
		const hadSavedPositions = Object.keys(map.nodePositions).length > 0;
		const resolved = resolveMapSources(this.app, map);
		const results = await Promise.all(resolved.files.map(async (file) => {
			try {
				const content = await this.app.vault.cachedRead(file);
				return [file.path, parseTaskFile(file.path, content)] as const;
			} catch {
				return [file.path, [] as TaskNode[]] as const;
			}
		}));

		this.taskCache.clear();
		results.forEach(([path, tasks]) => this.taskCache.set(path, tasks));
		if (!this.currentFilePath || !resolved.files.some((file) => file.path === this.currentFilePath)) {
			const preferred = this.plugin.pendingScopePath;
			this.currentFilePath = resolved.files.some((file) => file.path === preferred)
				? preferred
				: resolved.files[0]?.path ?? '';
			this.plugin.pendingScopePath = '';
		}
		this.graphData = buildTaskGraph(Array.from(this.taskCache.values()).flat());
		this.seedMissingPositions();
		if (!hadSavedPositions && this.graphData.nodes.length > 0) this.shouldFitAfterRender = true;
		this.graphCanvas?.setViewport(map.viewport);
		this.renderSourcePanel();
		this.renderGraph();
		if (this.shouldFitAfterRender) {
			this.shouldFitAfterRender = false;
			window.setTimeout(() => this.graphCanvas?.fitView(), 0);
		}
	}

	private seedMissingPositions(): void {
		const map = this.activeMap;
		const layout = layoutGraph(this.graphData.nodes, this.graphData.edges);
		let changed = false;
		layout.nodes.forEach((node) => {
			const key = taskPositionKey(node);
			if (!map.nodePositions[key]) {
				map.nodePositions[key] = { x: node.x, y: node.y };
				changed = true;
			}
		});
		if (changed) this.queueSave();
	}

	private renderSourcePanel(): void {
		if (!this.sourceTreeEl) return;
		const map = this.activeMap;
		this.renderSourceSummary();
		renderSourceTree(
			this.app,
			this.sourceTreeEl,
			map.sources,
			this.sourceQuery,
			(next) => {
				map.sources = next;
				this.queueSave();
				void this.reloadMap();
			},
			(file) => {
				if (!mapContainsPath(map, file.path)) {
					new Notice('请先勾选这个文件或它所在的文件夹');
					return;
				}
				this.currentFilePath = file.path;
				this.renderSourcePanel();
			},
			this.expandedSourceFolders,
			this.currentFilePath,
		);

		const missing = resolveMapSources(this.app, map).missing;
		if (missing.length > 0) {
			const section = this.sourceTreeEl.createDiv('tgf-missing-sources');
			section.createDiv({ cls: 'tgf-section-title', text: '来源缺失' });
			missing.forEach((source) => section.createDiv({
				cls: 'tgf-missing-source',
				text: `${source.type === 'folder' ? '文件夹' : '文件'} · ${source.path}`,
			}));
		}
		this.renderCurrentFile();
	}

	private renderSourceSummary(): void {
		this.sourceSummaryEl.empty();
		const header = this.sourceSummaryEl.createDiv('tgf-source-summary-header');
		header.createSpan({ text: `已选来源 · ${this.activeMap.sources.length}` });
		header.createEl('button', { text: '管理' }).addEventListener('click', () => void this.manageSources());
		if (this.activeMap.sources.length === 0) {
			this.sourceSummaryEl.createDiv({ cls: 'tgf-source-summary-empty', text: '还没有选择文件或文件夹' });
			return;
		}
		const chips = this.sourceSummaryEl.createDiv('tgf-source-chips');
		this.activeMap.sources.slice(0, 4).forEach((source) => {
			const chip = chips.createDiv('tgf-source-chip');
			chip.setAttribute('aria-label', source.path);
			setIcon(chip.createSpan(), source.type === 'folder' ? 'folder' : 'file-text');
			chip.createSpan({ cls: 'tgf-source-chip-path', text: source.path });
			const remove = chip.createEl('button', {
				cls: 'tgf-source-chip-remove',
				attr: { 'aria-label': `移除来源 ${source.path}`, title: '从地图移除来源' },
			});
			setIcon(remove, 'x');
			remove.addEventListener('click', () => {
				this.activeMap.sources = toggleSource(this.activeMap.sources, source, false);
				this.queueSave();
				void this.reloadMap();
			});
		});
		if (this.activeMap.sources.length > 4) {
			chips.createSpan({ cls: 'tgf-source-more', text: `+${this.activeMap.sources.length - 4}` });
		}
	}

	private renderCurrentFile(): void {
		this.currentFileEl.empty();
		const header = this.currentFileEl.createDiv('tgf-current-file-header');
		header.createDiv({ cls: 'tgf-section-title', text: '当前文件' });
		if (!this.currentFilePath) {
			this.currentFileEl.createDiv({
				cls: 'tgf-current-file-empty',
				text: '从上方文件树勾选并点击一个 Markdown 文件。',
			});
			return;
		}
		header.createDiv({
			cls: 'tgf-current-file-path',
			text: this.currentFilePath,
			attr: { 'aria-label': this.currentFilePath },
		});
		const createButton = this.currentFileEl.createEl('button', {
			cls: 'mod-cta tgf-current-create',
			text: '在当前文件中新建任务',
		});
		createButton.addEventListener('click', () => void this.createTask(this.currentFilePath));
		const tasks = this.taskCache.get(this.currentFilePath) ?? [];
		const list = this.currentFileEl.createDiv('tgf-file-task-list');
		if (tasks.length === 0) list.createDiv({ cls: 'tgf-muted', text: '这个文件中还没有任务。' });
		tasks.forEach((task) => {
			const row = list.createEl('button', {
				cls: 'tgf-file-task',
				attr: { 'aria-label': task.text },
			});
			row.createSpan({ cls: `tgf-mini-status is-${task.status}` });
			row.createSpan({ cls: 'tgf-file-task-text', text: task.text });
			row.addEventListener('click', () => {
				this.selectedId = task.id;
				this.renderGraph();
			});
		});
	}

	private createPositionedLayout(): LayoutResult {
		const automatic = layoutGraph(this.graphData.nodes, this.graphData.edges);
		let width = automatic.width;
		let height = automatic.height;
		const nodes = automatic.nodes.map((node) => {
			const saved = this.activeMap.nodePositions[taskPositionKey(node)];
			const positioned = saved ? { ...node, x: saved.x, y: saved.y } : node;
			width = Math.max(width, positioned.x + positioned.width + 72);
			height = Math.max(height, positioned.y + positioned.height + 72);
			return positioned;
		});
		return { nodes, width, height };
	}

	private renderGraph(): void {
		const allLayout = this.createPositionedLayout();
		const queryMatches = new Set<string>();
		if (this.searchQuery) {
			this.graphData.nodes.forEach((node) => {
				const haystack = `${node.text} ${node.taskId ?? ''} ${node.tags.join(' ')} ${node.path}`.toLocaleLowerCase();
				if (haystack.includes(this.searchQuery)) queryMatches.add(node.id);
			});
		}
		const relatedIds = this.searchQuery ? this.collectRelatedIds(queryMatches) : null;
		const nodes = allLayout.nodes.filter((node) => {
			if (!this.enabledStatuses.has(node.status)) return false;
			return relatedIds ? relatedIds.has(node.id) : true;
		});
		const visibleIds = new Set(nodes.map((node) => node.id));
		const edges = this.graphData.edges.filter((edge) => (
			visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId)
		));
		if (this.selectedId && !visibleIds.has(this.selectedId)) this.selectedId = null;
		this.graphCanvas?.render({ ...allLayout, nodes }, edges, this.selectedId);
		const selected = this.selectedId
			? this.graphData.nodes.find((node) => node.id === this.selectedId) ?? null
			: null;
		this.renderInspector(selected);
		this.renderStatusBar(nodes);
	}

	private collectRelatedIds(seedIds: Set<string>): Set<string> {
		const result = new Set(seedIds);
		let changed = true;
		while (changed) {
			changed = false;
			this.graphData.edges.forEach((edge) => {
				if (edge.missing) return;
				if (result.has(edge.sourceId) || result.has(edge.targetId)) {
					if (!result.has(edge.sourceId)) {
						result.add(edge.sourceId);
						changed = true;
					}
					if (!result.has(edge.targetId)) {
						result.add(edge.targetId);
						changed = true;
					}
				}
			});
		}
		return result;
	}

	private async organizeGraph(): Promise<void> {
		const layout = layoutGraph(this.graphData.nodes, this.graphData.edges);
		const positions: Record<string, NodePosition> = {};
		layout.nodes.forEach((node) => {
			positions[taskPositionKey(node)] = { x: node.x, y: node.y };
		});
		this.activeMap.nodePositions = positions;
		await this.plugin.persistData();
		this.renderGraph();
		window.setTimeout(() => this.graphCanvas?.fitView(), 0);
		new Notice('已按依赖关系重新规整地图');
	}

	private saveNodePosition(node: PositionedTaskNode, position: NodePosition): void {
		this.activeMap.nodePositions[taskPositionKey(node)] = position;
		this.queueSave();
	}

	private saveViewport(viewport: ViewportState): void {
		this.activeMap.viewport = viewport;
		this.queueSave();
	}

	private queueSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.plugin.persistData();
		}, 300);
	}

	private selectNode(node: PositionedTaskNode): void {
		this.selectedId = node.id;
		this.graphCanvas?.setSelected(node.id);
		this.renderInspector(node);
	}

	private renderInspector(node: DerivedTaskNode | null): void {
		this.inspectorEl.empty();
		if (!node) {
			this.inspectorEl.addClass('is-empty');
			const icon = this.inspectorEl.createDiv('tgf-empty-icon');
			setIcon(icon, 'mouse-pointer-click');
			this.inspectorEl.createDiv({ cls: 'tgf-empty-title', text: '选择一个任务' });
			this.inspectorEl.createDiv({
				cls: 'tgf-empty-description',
				text: '查看、编辑或从这里创建后续任务',
			});
			return;
		}
		this.inspectorEl.removeClass('is-empty');
		const header = this.inspectorEl.createDiv('tgf-inspector-header');
		header.createDiv({ cls: `tgf-inspector-kicker is-${node.readiness}`, text: this.readinessLabel(node) });
		const close = this.createIconButton(header, 'x', '关闭详情', () => {
			this.selectedId = null;
			this.graphCanvas?.setSelected(null);
			this.renderInspector(null);
		});
		close.addClass('tgf-inspector-close');
		this.inspectorEl.createEl('h2', {
			cls: 'tgf-inspector-title',
			text: node.text,
			attr: { 'aria-label': node.text },
		});
		const source = this.inspectorEl.createDiv('tgf-inspector-source');
		setIcon(source.createSpan(), 'file-text');
		source.createSpan({ text: `${node.path} · 第 ${node.line + 1} 行` });
		if (node.headingPath.length > 0) {
			this.inspectorEl.createDiv({ cls: 'tgf-heading-path', text: node.headingPath.join(' / ') });
		}
		const facts = this.inspectorEl.createDiv('tgf-facts');
		this.addFact(facts, '状态', STATUS_LABELS[node.status]);
		this.addFact(facts, '任务 ID', node.taskId ?? '未分配（独立任务可不需要）');
		if (node.priority) this.addFact(facts, '优先级', node.priority);
		if (node.startDate) this.addFact(facts, '开始', node.startDate);
		if (node.dueDate) this.addFact(facts, '截止', node.dueDate);
		if (node.tags.length > 0) {
			const tags = this.inspectorEl.createDiv('tgf-inspector-section');
			tags.createDiv({ cls: 'tgf-section-title', text: '标签' });
			const tagRow = tags.createDiv('tgf-inspector-tags');
			node.tags.forEach((tag) => {
				const chip = tagRow.createEl('button', { text: `#${tag} ×` });
				chip.addEventListener('click', () => void this.removeTag(node, tag));
			});
		}
		const relationships = this.inspectorEl.createDiv('tgf-inspector-section');
		relationships.createDiv({ cls: 'tgf-section-title', text: '任务关系' });
		if (node.blockedByIds.length === 0 && node.dependentIds.length === 0) {
			relationships.createDiv({ cls: 'tgf-muted', text: '当前没有依赖关系' });
		} else {
			if (node.blockedByIds.length > 0) this.addRelationshipList(relationships, '前置', node.blockedByIds);
			if (node.dependentIds.length > 0) this.addRelationshipList(relationships, '后续', node.dependentIds);
		}
		if (node.warnings.length > 0) {
			const warning = this.inspectorEl.createDiv('tgf-inspector-warning');
			setIcon(warning.createSpan(), 'triangle-alert');
			warning.createSpan({ text: this.warningLabel(node) });
		}
		const actions = this.inspectorEl.createDiv('tgf-inspector-actions');
		const successor = actions.createEl('button', { cls: 'mod-cta', text: '创建后续任务' });
		successor.addEventListener('click', () => void this.createSuccessor(node));
		const predecessor = actions.createEl('button', { text: '创建前置任务' });
		predecessor.addEventListener('click', () => void this.createPredecessor(node));
		const edit = actions.createEl('button', { text: '编辑任务' });
		edit.addEventListener('click', () => void this.editTask(node));
		if (!node.taskId || node.warnings.includes('duplicate-id')) {
			const assignId = actions.createEl('button', {
				text: node.taskId ? '重新生成 ID' : '生成任务 ID',
			});
			assignId.addEventListener('click', () => void this.generateTaskId(node));
		}
		const star = actions.createEl('button', { text: node.starred ? '取消星标' : '添加星标' });
		star.addEventListener('click', () => void this.toggleStar(node));
		const addTag = actions.createEl('button', { text: '添加标签' });
		addTag.addEventListener('click', () => void this.addTag(node));
		const open = actions.createEl('button', { text: '打开原文' });
		open.addEventListener('click', () => void this.openTask(node));
		const toggle = actions.createEl('button', {
			text: node.status === 'todo'
				? '开始任务'
				: node.status === 'in_progress'
					? '标记完成'
					: '恢复待办',
		});
		toggle.addEventListener('click', () => void this.toggleTask(node));
		const remove = actions.createEl('button', { cls: 'mod-warning', text: '删除任务' });
		remove.addEventListener('click', () => void this.deleteTask(node));
	}

	private addFact(parent: HTMLElement, label: string, value: string): void {
		const row = parent.createDiv('tgf-fact');
		row.createSpan({ cls: 'tgf-fact-label', text: label });
		row.createSpan({ cls: 'tgf-fact-value', text: value });
	}

	private addRelationshipList(parent: HTMLElement, label: string, ids: string[]): void {
		const row = parent.createDiv('tgf-relationship');
		row.createSpan({ cls: 'tgf-relationship-label', text: label });
		const values = row.createDiv('tgf-relationship-values');
		ids.forEach((id) => {
			const node = this.graphData.nodes.find((item) => item.id === id);
			values.createSpan({ text: node?.taskId ?? id });
		});
	}

	private readinessLabel(node: DerivedTaskNode): string {
		if (node.readiness === 'ready') return '现在可以开始';
		if (node.readiness === 'blocked') return `被 ${node.unresolvedDependencyIds.length} 项任务阻塞`;
		if (node.readiness === 'active') return '正在进行';
		return node.status === 'canceled' ? '已取消' : '已经完成';
	}

	private warningLabel(node: DerivedTaskNode): string {
		const labels: string[] = [];
		if (node.warnings.includes('missing-id')) labels.push('参与关系但缺少任务 ID');
		if (node.warnings.includes('duplicate-id')) labels.push('任务 ID 与地图中其他任务重复');
		if (node.warnings.includes('missing-reference')) labels.push('引用的前置任务不存在于当前地图');
		if (node.warnings.includes('cycle')) labels.push('检测到循环依赖');
		return labels.join('；');
	}

	private renderStatusBar(visibleNodes: DerivedTaskNode[]): void {
		this.statusBarEl.empty();
		const total = this.graphData.nodes.length;
		const done = this.graphData.nodes.filter((node) => node.status === 'done').length;
		const active = this.graphData.nodes.filter((node) => node.readiness === 'active').length;
		const ready = this.graphData.nodes.filter((node) => node.readiness === 'ready').length;
		const blocked = this.graphData.nodes.filter((node) => node.readiness === 'blocked').length;
		const warnings = this.graphData.nodes.filter((node) => node.warnings.length > 0).length;
		const missing = resolveMapSources(this.app, this.activeMap).missing.length;
		this.statusBarEl.createSpan({ cls: 'tgf-status-primary', text: `${visibleNodes.length} / ${total} 个任务` });
		this.statusBarEl.createSpan({ text: `${done} 已完成` });
		this.statusBarEl.createSpan({ text: `${active} 进行中` });
		this.statusBarEl.createSpan({ cls: 'is-ready', text: `${ready} 可开始` });
		this.statusBarEl.createSpan({ cls: blocked > 0 ? 'is-blocked' : '', text: `${blocked} 被阻塞` });
		if (warnings > 0) this.statusBarEl.createSpan({ cls: 'is-warning', text: `${warnings} 项需检查` });
		const repairable = this.graphData.nodes.filter((node) => node.warnings.includes('missing-id'));
		if (repairable.length > 0) {
			const repair = this.statusBarEl.createEl('button', {
				cls: 'tgf-status-repair',
				text: `修复 ${repairable.length} 个关系任务 ID`,
			});
			repair.addEventListener('click', () => void this.repairRelationshipIds(repairable));
		}
		if (missing > 0) this.statusBarEl.createSpan({ cls: 'is-warning', text: `${missing} 个来源缺失` });
		if (!getTasksApi(this.app)) {
			this.statusBarEl.createSpan({ cls: 'is-warning', text: 'Tasks 未启用：创建与编辑不可用' });
		}
	}

	private async createTask(defaultPath?: string, position?: NodePosition): Promise<void> {
		const api = getTasksApi(this.app);
		if (!api) {
			new Notice('需要安装并启用 Tasks 插件后才能创建任务');
			return;
		}
		if (this.activeMap.sources.length === 0) {
			new Notice('请先为当前地图选择文件或文件夹来源');
			return;
		}
		const target = await chooseTaskTarget(this.app, this.activeMap, defaultPath ?? this.currentFilePath);
		if (!target) return;
		const taskLine = await api.createTaskLineModal();
		if (!taskLine) return;
		const prepared = prepareNewTaskLine(taskLine, this.nextTaskId());
		try {
			const file = await this.writeNewTask(target, prepared.line);
			const parsed = parseTaskFile(file.path, prepared.line)[0];
			if (parsed) {
				const suggested = position ?? this.graphCanvas?.getViewportCenter() ?? { x: 72, y: 72 };
				this.activeMap.nodePositions[taskPositionKey(parsed)] = suggested;
			}
			this.currentFilePath = file.path;
			await this.plugin.persistData();
			await this.reloadMap();
			new Notice('任务已添加到地图');
		} catch (error) {
			this.showError(error, '创建任务失败');
		}
	}

	private async writeNewTask(target: TaskTarget, line: string): Promise<TFile> {
		if (target.file) {
			await appendTaskLine(this.app, target.file, line);
			return target.file;
		}
		if (!target.newPath) throw new Error('没有有效的目标文件');
		return this.app.vault.create(target.newPath, `${normalizeTaskLine(line)}\n`);
	}

	private nextTaskId(): string {
		return createTaskId(
			this.graphData.nodes
				.map((node) => node.taskId)
				.filter((id): id is string => Boolean(id)),
		);
	}

	private async createSuccessor(parent: DerivedTaskNode, preferredPosition?: NodePosition): Promise<void> {
		if (parent.warnings.includes('duplicate-id')) {
			new Notice('请先在详情面板为这个任务重新生成唯一 ID');
			return;
		}
		const api = getTasksApi(this.app);
		if (!api) {
			new Notice('需要安装并启用 Tasks 插件后才能创建后续任务');
			return;
		}
		const target = await chooseTaskTarget(this.app, this.activeMap, parent.path);
		if (!target) return;
		const candidateId = parent.taskId ?? this.nextTaskId();
		const usedIds = new Set(this.graphData.nodes.flatMap((node) => node.taskId ? [node.taskId] : []));
		usedIds.add(candidateId);
		const candidateChildId = createTaskId(usedIds);
		const taskLine = await api.editTaskLineModal(`- [ ] 🆔 ${candidateChildId} ⛔ ${candidateId}`);
		if (!taskLine) return;
		const oldParentKey = taskPositionKey(parent);
		const parentPosition = this.activeMap.nodePositions[oldParentKey];
		let targetFile = target.file;
		let createdFile: TFile | null = null;
		try {
			if (!targetFile && target.newPath) {
				createdFile = await this.app.vault.create(target.newPath, '');
				targetFile = createdFile;
			}
			if (!targetFile) throw new Error('没有有效的目标文件');
			const result = await createSuccessorTask(
				this.app,
				parent,
				targetFile,
				taskLine,
				candidateId,
				candidateChildId,
			);
			if (result.parentWasUpdated && parentPosition) {
				delete this.activeMap.nodePositions[oldParentKey];
				this.activeMap.nodePositions[`id:${result.parentId}`] = parentPosition;
			}
			await this.reloadMap();
			const child = (this.taskCache.get(targetFile.path) ?? [])
				.filter((task) => task.taskId === result.childId)
				.sort((a, b) => b.line - a.line)[0];
			if (child) {
				this.activeMap.nodePositions[taskPositionKey(child)] = this.findBranchAppendPosition(
					result.parentId,
					child,
					'successor',
					preferredPosition,
				);
				this.selectedId = child.id;
			}
			this.currentFilePath = targetFile.path;
			await this.plugin.persistData();
			this.renderSourcePanel();
			this.renderGraph();
			new Notice('后续任务已创建');
		} catch (error) {
			if (createdFile) {
				try {
					await this.app.vault.delete(createdFile);
				} catch {
					// The write error is more useful than a cleanup error.
				}
			}
			this.showError(error, '创建后续任务失败');
		}
	}

	private async createPredecessor(child: DerivedTaskNode, preferredPosition?: NodePosition): Promise<void> {
		if (child.warnings.includes('duplicate-id')) {
			new Notice('请先在详情面板为这个任务重新生成唯一 ID');
			return;
		}
		const api = getTasksApi(this.app);
		if (!api) {
			new Notice('需要安装并启用 Tasks 插件后才能创建前置任务');
			return;
		}
		const target = await chooseTaskTarget(this.app, this.activeMap, child.path);
		if (!target) return;
		const candidateParentId = this.nextTaskId();
		const usedIds = new Set(this.graphData.nodes.flatMap((node) => node.taskId ? [node.taskId] : []));
		usedIds.add(candidateParentId);
		const candidateChildId = child.taskId ?? createTaskId(usedIds);
		const taskLine = await api.editTaskLineModal(`- [ ] 🆔 ${candidateParentId}`);
		if (!taskLine) return;
		const oldChildKey = taskPositionKey(child);
		const childPosition = this.activeMap.nodePositions[oldChildKey];
		let targetFile = target.file;
		let createdFile: TFile | null = null;
		try {
			if (!targetFile && target.newPath) {
				createdFile = await this.app.vault.create(target.newPath, '');
				targetFile = createdFile;
			}
			if (!targetFile) throw new Error('没有有效的目标文件');
			const result = await createPredecessorTask(
				this.app,
				child,
				targetFile,
				taskLine,
				candidateParentId,
				candidateChildId,
			);
			if (result.childWasUpdated && childPosition) {
				delete this.activeMap.nodePositions[oldChildKey];
				this.activeMap.nodePositions[`id:${result.childId}`] = childPosition;
			}
			await this.reloadMap();
			const parent = (this.taskCache.get(targetFile.path) ?? []).find(
				(task) => task.taskId === result.parentId,
			);
			if (parent) {
				this.activeMap.nodePositions[taskPositionKey(parent)] = this.findBranchAppendPosition(
					result.childId,
					parent,
					'predecessor',
					preferredPosition,
				);
				this.selectedId = parent.id;
			}
			this.currentFilePath = targetFile.path;
			await this.plugin.persistData();
			this.renderSourcePanel();
			this.renderGraph();
			new Notice('前置任务已创建');
		} catch (error) {
			if (createdFile) {
				try {
					await this.app.vault.delete(createdFile);
				} catch {
					// Keep the original write error.
				}
			}
			this.showError(error, '创建前置任务失败');
		}
	}

	private wouldCreateCycle(parent: DerivedTaskNode, child: DerivedTaskNode): boolean {
		if (parent.id === child.id) return true;
		const outgoing = new Map<string, string[]>();
		this.graphData.edges.filter((edge) => !edge.missing).forEach((edge) => {
			const values = outgoing.get(edge.sourceId) ?? [];
			values.push(edge.targetId);
			outgoing.set(edge.sourceId, values);
		});
		const pending = [child.id];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const id = pending.pop()!;
			if (id === parent.id) return true;
			if (visited.has(id)) continue;
			visited.add(id);
			pending.push(...(outgoing.get(id) ?? []));
		}
		return false;
	}

	private async connectNodes(parent: DerivedTaskNode, child: DerivedTaskNode): Promise<void> {
		if (parent.warnings.includes('duplicate-id') || child.warnings.includes('duplicate-id')) {
			new Notice('存在重复任务 ID，请先在详情面板重新生成唯一 ID');
			return;
		}
		if (parent.id === child.id) {
			new Notice('不能把任务连接到自身');
			return;
		}
		if (parent.taskId && child.blockedByIds.includes(parent.taskId)) {
			new Notice('这两个任务已经存在前置关系');
			return;
		}
		if (this.wouldCreateCycle(parent, child)) {
			new Notice('无法建立关系：这会形成循环依赖');
			return;
		}
		const parentOldKey = taskPositionKey(parent);
		const childOldKey = taskPositionKey(child);
		const parentPosition = this.activeMap.nodePositions[parentOldKey];
		const childPosition = this.activeMap.nodePositions[childOldKey];
		const parentCandidate = parent.taskId ?? this.nextTaskId();
		const used = new Set(this.graphData.nodes.flatMap((node) => node.taskId ? [node.taskId] : []));
		used.add(parentCandidate);
		const childCandidate = child.taskId ?? createTaskId(used);
		try {
			const result = await connectTasks(
				this.app,
				parent,
				child,
				parentCandidate,
				childCandidate,
			);
			if (result.parentWasUpdated && parentPosition) {
				delete this.activeMap.nodePositions[parentOldKey];
				this.activeMap.nodePositions[`id:${result.parentId}`] = parentPosition;
			}
			if (result.childWasUpdated && childPosition) {
				delete this.activeMap.nodePositions[childOldKey];
				this.activeMap.nodePositions[`id:${result.childId}`] = childPosition;
			}
			await this.plugin.persistData();
			await this.reloadMap();
			new Notice('任务关系已建立');
		} catch (error) {
			this.showError(error, '建立任务关系失败');
		}
	}

	private async removeRelationship(parent: DerivedTaskNode, child: DerivedTaskNode): Promise<void> {
		const confirmed = await confirmAction(
			this.app,
			'解除任务关系？',
			`将解除“${parent.text}”作为“${child.text}”前置任务的关系，不会删除任何任务。`,
			'解除关系',
			false,
		);
		if (!confirmed) return;
		try {
			await removeTaskRelationship(this.app, parent, child);
			await this.reloadMap();
			new Notice('任务关系已解除');
		} catch (error) {
			this.showError(error, '解除任务关系失败');
		}
	}

	private findBranchAppendPosition(
		anchorTaskId: string,
		newNode: TaskNode,
		direction: 'successor' | 'predecessor',
		preferred?: NodePosition,
	): NodePosition {
		const layout = this.createPositionedLayout();
		const anchor = layout.nodes.find((node) => node.taskId === anchorTaskId);
		const siblingIds = new Set(
			this.graphData.edges
				.filter((edge) => {
					if (edge.missing) return false;
					return direction === 'successor'
						? edge.sourceId === anchor?.id && edge.targetId !== newNode.id
						: edge.targetId === anchor?.id && edge.sourceId !== newNode.id;
				})
				.map((edge) => direction === 'successor' ? edge.targetId : edge.sourceId),
		);
		const siblings = layout.nodes.filter((node) => siblingIds.has(node.id));
		const defaultX = direction === 'successor'
			? (anchor?.x ?? 72) + 328
			: Math.max(24, (anchor?.x ?? 400) - 328);
		const branchX = preferred?.x ?? siblings[0]?.x ?? defaultX;
		const firstY = preferred?.y ?? anchor?.y ?? 72;
		const afterSiblingsY = siblings.length > 0
			? Math.max(...siblings.map((node) => node.y + node.height + 34))
			: firstY;
		const branchY = siblings.length > 0
			? Math.max(firstY, afterSiblingsY)
			: firstY;
		const newNodeKey = taskPositionKey(newNode);
		return this.findFreePosition(
			{ x: branchX, y: branchY },
			new Set([newNodeKey]),
		);
	}

	private findFreePosition(preferred: NodePosition, ignoredKeys = new Set<string>()): NodePosition {
		const occupied = Object.entries(this.activeMap.nodePositions)
			.filter(([key]) => !ignoredKeys.has(key))
			.map(([, position]) => position);
		let candidate = { ...preferred };
		for (let attempt = 0; attempt < 30; attempt += 1) {
			const collision = occupied.some((position) => (
				Math.abs(position.x - candidate.x) < 240 && Math.abs(position.y - candidate.y) < 126
			));
			if (!collision) return candidate;
			candidate = { x: preferred.x, y: preferred.y + (attempt + 1) * 148 };
		}
		return candidate;
	}

	private async editTask(task: TaskNode): Promise<void> {
		const api = getTasksApi(this.app);
		if (!api) {
			new Notice('需要安装并启用 Tasks 插件后才能编辑任务');
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(task.path);
		if (!(file instanceof TFile)) {
			new Notice(`找不到文件：${task.path}`);
			return;
		}
		try {
			const content = await this.app.vault.read(file);
			const lines = content.split(/\r?\n/);
			const lineIndex = findTaskLine(lines, task);
			if (lineIndex < 0) throw new Error(`找不到任务：${task.text}`);
			const editedLine = await api.editTaskLineModal(lines[lineIndex]);
			if (!editedLine) return;
			const protectedLine = task.taskId
				? replaceTaskId(editedLine, task.taskId)
				: task.blockedByIds.length > 0
					? ensureTaskId(editedLine, this.nextTaskId()).line
					: editedLine;
			const oldKey = taskPositionKey(task);
			const oldPosition = this.activeMap.nodePositions[oldKey];
			await replaceTaskLine(this.app, task, protectedLine);
			const parsed = parseTaskFile(task.path, normalizeTaskLine(protectedLine))[0];
			if (parsed && oldPosition) {
				const newKey = taskPositionKey(parsed);
				if (newKey !== oldKey) delete this.activeMap.nodePositions[oldKey];
				this.activeMap.nodePositions[newKey] = oldPosition;
			}
			await this.plugin.persistData();
			await this.reloadMap();
			new Notice('任务已更新');
		} catch (error) {
			this.showError(error, '编辑任务失败');
		}
	}

	private async generateTaskId(task: DerivedTaskNode): Promise<void> {
		const candidate = this.nextTaskId();
		const oldKey = taskPositionKey(task);
		const oldPosition = this.activeMap.nodePositions[oldKey];
		try {
			await assignTaskId(this.app, task, candidate, Boolean(task.taskId));
			if (oldPosition) {
				delete this.activeMap.nodePositions[oldKey];
				this.activeMap.nodePositions[`id:${candidate}`] = oldPosition;
			}
			await this.plugin.persistData();
			await this.reloadMap();
			const updated = this.graphData.nodes.find((node) => node.taskId === candidate);
			if (updated) this.selectNode(updated as PositionedTaskNode);
			new Notice(`任务 ID 已生成：${candidate}`);
		} catch (error) {
			this.showError(error, '生成任务 ID 失败');
		}
	}

	private async repairRelationshipIds(tasks: TaskNode[]): Promise<void> {
		const confirmed = await confirmAction(
			this.app,
			'修复关系任务 ID？',
			`将为 ${tasks.length} 个参与关系但缺少 ID 的任务写入唯一 ID，并保留当前布局。`,
			'修复 ID',
			false,
		);
		if (!confirmed) return;
		const oldPositions = new Map(tasks.map((task) => [
			task.id,
			{ key: taskPositionKey(task), position: this.activeMap.nodePositions[taskPositionKey(task)] },
		]));
		try {
			const assigned = await repairTaskIds(
				this.app,
				tasks,
				this.graphData.nodes.flatMap((node) => node.taskId ? [node.taskId] : []),
			);
			assigned.forEach((taskId, internalId) => {
				const previous = oldPositions.get(internalId);
				if (!previous?.position) return;
				delete this.activeMap.nodePositions[previous.key];
				this.activeMap.nodePositions[`id:${taskId}`] = previous.position;
			});
			await this.plugin.persistData();
			await this.reloadMap();
			new Notice(`已修复 ${assigned.size} 个任务 ID`);
		} catch (error) {
			this.showError(error, '批量修复任务 ID 失败');
		}
	}

	private async toggleStar(task: TaskNode): Promise<void> {
		try {
			await setTaskStar(this.app, task, !task.starred);
			await this.reloadMap();
		} catch (error) {
			this.showError(error, '更新星标失败');
		}
	}

	private async addTag(task: TaskNode): Promise<void> {
		const tag = await requestTextValue(this.app, '添加任务标签', '标签', '例如：设计');
		if (!tag) return;
		try {
			await changeTaskTag(this.app, task, tag, true);
			await this.reloadMap();
		} catch (error) {
			this.showError(error, '添加标签失败');
		}
	}

	private async removeTag(task: TaskNode, tag: string): Promise<void> {
		try {
			await changeTaskTag(this.app, task, tag, false);
			await this.reloadMap();
		} catch (error) {
			this.showError(error, '移除标签失败');
		}
	}

	private async deleteTask(task: DerivedTaskNode): Promise<void> {
		const dependents = task.id
			? this.graphData.nodes.filter((node) => task.dependentIds.includes(node.id))
			: [];
		const description = dependents.length > 0
			? `将删除“${task.text}”，并从 ${dependents.length} 个后续任务中解除对应依赖。此操作会修改笔记原文。`
			: `将从笔记中删除“${task.text}”。此操作无法在 Task Graph 中撤销。`;
		const confirmed = await confirmAction(this.app, '删除任务？', description);
		if (!confirmed) return;
		try {
			await deleteTaskAndReferences(this.app, task, dependents);
			delete this.activeMap.nodePositions[taskPositionKey(task)];
			this.selectedId = null;
			await this.plugin.persistData();
			await this.reloadMap();
			new Notice('任务已删除');
		} catch (error) {
			this.showError(error, '删除任务失败');
		}
	}

	private async openTask(task: TaskNode): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(task.path);
		if (!(file instanceof TFile)) {
			new Notice(`找不到文件：${task.path}`);
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.openFile(file);
		window.setTimeout(() => {
			const view = leaf.view;
			if (view instanceof MarkdownView) {
				view.editor.setCursor({ line: task.line, ch: 0 });
				view.editor.scrollIntoView({
					from: { line: Math.max(0, task.line - 3), ch: 0 },
					to: { line: task.line + 3, ch: 0 },
				}, true);
				view.editor.focus();
			}
		}, 50);
	}

	private async toggleTask(task: TaskNode): Promise<void> {
		const api = getTasksApi(this.app);
		if (!api) {
			new Notice('需要安装并启用 Tasks 插件后才能更新任务状态');
			return;
		}
		try {
			if (task.status === 'todo') {
				await markTaskInProgress(this.app, task);
			} else {
				const file = this.app.vault.getAbstractFileByPath(task.path);
				if (!(file instanceof TFile)) throw new Error(`找不到文件：${task.path}`);
				const content = await this.app.vault.read(file);
				const lines = content.split(/\r?\n/);
				const lineIndex = findTaskLine(lines, task);
				if (lineIndex < 0) throw new Error(`找不到任务：${task.text}`);
				if (task.status === 'canceled') {
					lines[lineIndex] = lines[lineIndex]
						.replace(/^(\s*(?:>\s*)*(?:[-*+]|\d+\.)\s+)\[-\]/, '$1[ ]')
						.replace(/\s*❌\s*\d{4}-\d{2}-\d{2}/g, '');
					await this.app.vault.modify(file, lines.join('\n'));
				} else {
					const toggled = api.executeToggleTaskDoneCommand(lines[lineIndex], task.path);
					await replaceTaskLine(this.app, task, toggled);
				}
			}
			await this.reloadMap();
		} catch (error) {
			this.showError(error, '任务更新失败');
		}
	}

	private showError(error: unknown, fallback: string): void {
		new Notice(error instanceof Error ? error.message : fallback);
	}

	private scheduleReload(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.reloadMap();
		}, 280);
	}
}
