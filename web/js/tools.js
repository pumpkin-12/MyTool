'use strict';

/* ---------- 工具注册表 ---------- */
const registry = [];
function registerTool(tool) { registry.push(tool); }

/* 当前启用的工具（首页只显示这些；恢复某个工具把它加回列表即可，数据不会丢） */
const ENABLED_TOOLS = ['internlog', 'sketch', 'mermaid', 'quiz', 'defect'];
function isEnabled(t) { return ENABLED_TOOLS.indexOf(t.id) >= 0; }
