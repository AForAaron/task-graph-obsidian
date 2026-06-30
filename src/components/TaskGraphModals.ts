import {
	App,
	Modal,
	normalizePath,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
	setIcon,
} from 'obsidian';
import { MapSource, TaskMapConfig } from '../model/TaskGraphModel';
import {
	isSourceSelected,
	resolveMapSources,
	sourceContainsPath,
	toggleSource,
} from '../services/MapSourceResolver';

export function requestMapName(
	app: App,
	title: string,
	initialValue = '',
): Promise<string | null> {
	return new Promise((resolve) => {
		class NameModal extends Modal {
			private value = initialValue;
			private submitted = false;

			onOpen(): void {
				this.modalEl.addClass('tgf-name-modal');
				this.titleEl.setText(title);
				const submit = () => {
					if (!this.value || this.submitted) return;
					this.submitted = true;
					this.close();
				};
				new Setting(this.contentEl)
					.setName('地图名称')
					.addText((text) => {
						text.setValue(initialValue).setPlaceholder('例如：网站改版');
						text.inputEl.addEventListener('input', () => {
							this.value = text.getValue().trim();
						});
						text.inputEl.addEventListener('keydown', (event) => {
							if (event.key === 'Enter' && this.value) {
								event.preventDefault();
								submit();
							}
						});
						window.setTimeout(() => text.inputEl.focus(), 0);
					});
				const actions = this.contentEl.createDiv('tgf-modal-actions');
				const cancel = actions.createEl('button', { text: '取消' });
				cancel.type = 'button';
				cancel.addEventListener('click', () => this.close());
				const confirm = actions.createEl('button', { cls: 'mod-cta', text: '确认' });
				confirm.type = 'button';
				confirm.addEventListener('click', submit);
			}

			onClose(): void {
				this.contentEl.empty();
				resolve(this.submitted ? this.value : null);
			}
		}
		new NameModal(app).open();
	});
}

export function confirmAction(
	app: App,
	title: string,
	description: string,
	confirmLabel = '删除',
	danger = true,
): Promise<boolean> {
	return new Promise((resolve) => {
		class ConfirmModal extends Modal {
			private confirmed = false;

			onOpen(): void {
				this.titleEl.setText(title);
				this.contentEl.createEl('p', { text: description });
				const actions = this.contentEl.createDiv('tgf-modal-actions');
				actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
				actions.createEl('button', {
					cls: danger ? 'mod-warning' : 'mod-cta',
					text: confirmLabel,
				}).addEventListener('click', () => {
					this.confirmed = true;
					this.close();
				});
			}

			onClose(): void {
				this.contentEl.empty();
				resolve(this.confirmed);
			}
		}
		new ConfirmModal(app).open();
	});
}

export function requestTextValue(
	app: App,
	title: string,
	label: string,
	placeholder = '',
): Promise<string | null> {
	return new Promise((resolve) => {
		class TextValueModal extends Modal {
			private value = '';
			private submitted = false;

			onOpen(): void {
				this.titleEl.setText(title);
				new Setting(this.contentEl).setName(label).addText((text) => {
					text.setPlaceholder(placeholder);
					text.inputEl.addEventListener('input', () => {
						this.value = text.getValue().trim();
					});
					text.inputEl.addEventListener('keydown', (event) => {
						if (event.key === 'Enter' && this.value) {
							this.submitted = true;
							this.close();
						}
					});
					window.setTimeout(() => text.inputEl.focus(), 0);
				});
				const actions = this.contentEl.createDiv('tgf-modal-actions');
				actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
				actions.createEl('button', { cls: 'mod-cta', text: '确认' }).addEventListener('click', () => {
					if (!this.value) return;
					this.submitted = true;
					this.close();
				});
			}

			onClose(): void {
				this.contentEl.empty();
				resolve(this.submitted ? this.value : null);
			}
		}
		new TextValueModal(app).open();
	});
}

function renderSourceRows(
	app: App,
	parent: HTMLElement,
	sources: MapSource[],
	query: string,
	onToggle: (source: MapSource, selected: boolean) => void,
	onFileClick?: (file: TFile) => void,
	expandedFolders = new Set<string>(),
	currentFilePath = '',
): void {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const matches = (file: TAbstractFile): boolean => (
		!normalizedQuery || file.path.toLocaleLowerCase().includes(normalizedQuery)
	);
	const hasMatchingChild = (folder: TFolder): boolean => (
		matches(folder) || folder.children.some((child) => (
			child instanceof TFolder ? hasMatchingChild(child) : matches(child)
		))
	);

	const renderEntry = (entry: TAbstractFile, depth: number): void => {
		if (entry instanceof TFile && entry.extension !== 'md') return;
		if (entry instanceof TFolder && !hasMatchingChild(entry)) return;
		if (entry instanceof TFile && !matches(entry)) return;

		const type: MapSource['type'] = entry instanceof TFolder ? 'folder' : 'file';
		const directSelected = isSourceSelected(sources, type, entry.path);
		const inheritedSource = sources.find((source) => (
			source.type === 'folder'
			&& source.path !== entry.path
			&& sourceContainsPath(source, entry.path)
		));
		const inherited = Boolean(inheritedSource);
		const row = parent.createDiv({
			cls: [
				'tgf-source-row',
				directSelected ? 'is-selected' : '',
				inherited ? 'is-inherited' : '',
				entry.path === currentFilePath ? 'is-current' : '',
			].filter(Boolean).join(' '),
		});
		row.style.setProperty('--tgf-tree-depth', String(depth));
		if (entry instanceof TFolder) {
			const expanded = Boolean(normalizedQuery) || expandedFolders.has(entry.path);
			const disclosure = row.createEl('button', {
				cls: 'tgf-tree-disclosure',
				attr: { 'aria-label': expanded ? '折叠文件夹' : '展开文件夹' },
			});
			setIcon(disclosure, expanded ? 'chevron-down' : 'chevron-right');
			disclosure.addEventListener('click', () => {
				if (expanded) expandedFolders.delete(entry.path);
				else expandedFolders.add(entry.path);
				parent.empty();
				renderSourceRows(
					app,
					parent,
					sources,
					query,
					onToggle,
					onFileClick,
					expandedFolders,
					currentFilePath,
				);
			});
		} else {
			row.createSpan({ cls: 'tgf-tree-spacer' });
		}
		const checkbox = row.createEl('input', { type: 'checkbox' });
		checkbox.checked = directSelected || inherited;
		checkbox.disabled = inherited;
		checkbox.setAttribute('aria-label', inherited
			? `由文件夹 ${inheritedSource?.path ?? ''} 包含`
			: directSelected ? '从地图移除来源' : '加入地图来源');
		checkbox.addEventListener('change', () => {
			onToggle(type === 'folder'
				? { type, path: entry.path, recursive: true }
				: { type, path: entry.path }, checkbox.checked);
		});
		const icon = row.createSpan({ cls: `tgf-source-icon is-${type}` });
		setIcon(icon, type === 'folder' ? 'folder' : 'file-text');
		const name = row.createSpan({ cls: 'tgf-source-name', text: entry.name || 'Vault 根目录' });
		name.setAttribute('aria-label', entry.path || 'Vault 根目录');
		if (entry instanceof TFile && onFileClick) {
			name.addClass('is-clickable');
			name.addEventListener('click', () => onFileClick(entry));
		}
		if (entry.path === currentFilePath) {
			row.createSpan({ cls: 'tgf-source-state is-current', text: '当前' });
		} else if (directSelected) {
			row.createSpan({ cls: 'tgf-source-state is-selected', text: '已加入' });
		} else if (inherited) {
			row.createSpan({ cls: 'tgf-source-state', text: '文件夹包含' });
		}
		if (entry instanceof TFolder) {
			const expanded = Boolean(normalizedQuery) || expandedFolders.has(entry.path);
			if (expanded) entry.children
				.slice()
				.sort((a, b) => {
					if (a instanceof TFolder !== b instanceof TFolder) return a instanceof TFolder ? -1 : 1;
					return a.name.localeCompare(b.name, 'zh-CN');
				})
				.forEach((child) => renderEntry(child, depth + 1));
		}
	};

	app.vault.getRoot().children
		.slice()
		.sort((a, b) => {
			if (a instanceof TFolder !== b instanceof TFolder) return a instanceof TFolder ? -1 : 1;
			return a.name.localeCompare(b.name, 'zh-CN');
		})
		.forEach((entry) => renderEntry(entry, 0));
}

export function renderSourceTree(
	app: App,
	parent: HTMLElement,
	sources: MapSource[],
	query: string,
	onToggle: (next: MapSource[]) => void,
	onFileClick?: (file: TFile) => void,
	expandedFolders = new Set<string>(),
	currentFilePath = '',
): void {
	parent.empty();
	renderSourceRows(app, parent, sources, query, (source, selected) => {
		onToggle(toggleSource(sources, source, selected));
	}, onFileClick, expandedFolders, currentFilePath);
}

export function openSourcePicker(app: App, map: TaskMapConfig): Promise<MapSource[] | null> {
	return new Promise((resolve) => {
		class SourceModal extends Modal {
			private draft = map.sources.map((source) => ({ ...source }));
			private query = '';
			private saved = false;
			private treeEl: HTMLElement;
			private expandedFolders = new Set<string>();

			onOpen(): void {
				this.modalEl.addClass('tgf-source-modal');
				this.titleEl.setText(`管理来源 · ${map.name}`);
				this.contentEl.createEl('p', {
					cls: 'setting-item-description',
					text: '勾选 Markdown 文件或文件夹。文件夹会递归包含之后新增的子文件。',
				});
				const search = this.contentEl.createEl('input', {
					type: 'search',
					cls: 'tgf-modal-search',
					placeholder: '搜索文件或文件夹',
				});
				this.treeEl = this.contentEl.createDiv('tgf-source-tree tgf-source-tree-modal');
				const draw = () => renderSourceTree(app, this.treeEl, this.draft, this.query, (next) => {
					this.draft = next;
					draw();
				}, undefined, this.expandedFolders);
				search.addEventListener('input', () => {
					this.query = search.value;
					draw();
				});
				draw();
				const actions = this.contentEl.createDiv('tgf-modal-actions');
				actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
				actions.createEl('button', { cls: 'mod-cta', text: '保存来源' }).addEventListener('click', () => {
					this.saved = true;
					this.close();
				});
			}

			onClose(): void {
				this.contentEl.empty();
				resolve(this.saved ? this.draft : null);
			}
		}
		new SourceModal(app).open();
	});
}

export interface TaskTarget {
	file: TFile | null;
	newPath: string | null;
}

export function chooseTaskTarget(
	app: App,
	map: TaskMapConfig,
	defaultPath?: string,
): Promise<TaskTarget | null> {
	return new Promise((resolve) => {
		class TargetModal extends Modal {
			private mode: 'existing' | 'new' = 'existing';
			private selectedPath = defaultPath ?? '';
			private selectedFolder = '';
			private newName = '';
			private submitted = false;
			private validationEl: HTMLElement;

			onOpen(): void {
				this.titleEl.setText('选择任务文件');
				const resolved = resolveMapSources(app, map);
				const folderSources = map.sources.filter((source): source is Extract<MapSource, { type: 'folder' }> => (
					source.type === 'folder'
				));
				if (!resolved.files.some((file) => file.path === this.selectedPath)) {
					this.selectedPath = resolved.files[0]?.path ?? '';
				}
				this.selectedFolder = folderSources[0]?.path ?? '';

				const tabs = this.contentEl.createDiv('tgf-target-tabs');
				const existingButton = tabs.createEl('button', { cls: 'is-active', text: '已有文件' });
				const newButton = tabs.createEl('button', { text: '在文件夹中新建' });
				const existingPane = this.contentEl.createDiv('tgf-target-pane');
				const newPane = this.contentEl.createDiv('tgf-target-pane');
				newPane.hide();

				const select = existingPane.createEl('select', { cls: 'dropdown tgf-target-select' });
				resolved.files.forEach((file) => select.createEl('option', { value: file.path, text: file.path }));
				select.value = this.selectedPath;
				select.addEventListener('change', () => {
					this.selectedPath = select.value;
				});
				if (resolved.files.length === 0) {
					existingPane.createEl('p', { cls: 'tgf-muted', text: '当前来源中还没有 Markdown 文件。' });
				}

				const folderSelect = newPane.createEl('select', { cls: 'dropdown tgf-target-select' });
				folderSources.forEach((source) => folderSelect.createEl('option', {
					value: source.path,
					text: source.path || 'Vault 根目录',
				}));
				folderSelect.value = this.selectedFolder;
				folderSelect.addEventListener('change', () => {
					this.selectedFolder = folderSelect.value;
				});
				const nameInput = newPane.createEl('input', {
					type: 'text',
					placeholder: '新文件名称，例如：下一步.md',
				});
				nameInput.addEventListener('input', () => {
					this.newName = nameInput.value.trim();
				});
				if (folderSources.length === 0) {
					newPane.createEl('p', { cls: 'tgf-muted', text: '需要先为地图选择一个文件夹来源。' });
				}

				const switchMode = (mode: 'existing' | 'new') => {
					this.mode = mode;
					existingPane.toggle(mode === 'existing');
					newPane.toggle(mode === 'new');
					existingButton.toggleClass('is-active', mode === 'existing');
					newButton.toggleClass('is-active', mode === 'new');
				};
				existingButton.addEventListener('click', () => switchMode('existing'));
				newButton.addEventListener('click', () => switchMode('new'));

				this.validationEl = this.contentEl.createDiv('tgf-target-validation');
				const actions = this.contentEl.createDiv('tgf-modal-actions');
				actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
				actions.createEl('button', { cls: 'mod-cta', text: '下一步' }).addEventListener('click', () => {
					const result = this.getResult();
					if (!result) return;
					this.submitted = true;
					this.close();
				});
			}

			private getResult(): TaskTarget | null {
				this.validationEl.empty();
				if (this.mode === 'existing') {
					const file = app.vault.getAbstractFileByPath(this.selectedPath);
					if (!(file instanceof TFile)) {
						this.validationEl.setText('请选择一个已有 Markdown 文件。');
						return null;
					}
					return { file, newPath: null };
				}
				if (!this.selectedFolder || !this.newName) {
					this.validationEl.setText('请选择文件夹并输入文件名。');
					return null;
				}
				const safeName = this.newName.endsWith('.md') ? this.newName : `${this.newName}.md`;
				if (safeName.includes('/') || safeName.includes('\\')) {
					this.validationEl.setText('文件名不能包含路径分隔符。');
					return null;
				}
				const newPath = normalizePath(`${this.selectedFolder}/${safeName}`);
				if (app.vault.getAbstractFileByPath(newPath)) {
					this.validationEl.setText('这个文件已经存在。');
					return null;
				}
				return { file: null, newPath };
			}

			onClose(): void {
				resolve(this.submitted ? this.getResult() : null);
			}
		}
		new TargetModal(app).open();
	});
}
