# Task Graph

Task Graph 是一个以用户选择来源为边界的 Obsidian Tasks 可编辑地图。

- 创建多张互相独立的命名地图。
- 选择多个 Markdown 文件或递归文件夹作为地图来源。
- 在侧栏、工具栏或画布空白处创建任务。
- 使用 Tasks 完整表单创建、编辑任务与后续任务。
- 自由拖动节点并分别保存每张地图的坐标和视口。
- 点击“规整”按依赖关系从左到右重新布局。

Tasks 关系沿用原生 Markdown 语法：

```md
- [ ] 项目 🆔 root001
- [ ] 子任务 🆔 task001 ⛔ root001
```

## 开发

```bash
npm install
npm run build
```

将 `main.js`、`manifest.json` 和 `styles.css` 复制到：

```text
<vault>/.obsidian/plugins/task-graph/
```
