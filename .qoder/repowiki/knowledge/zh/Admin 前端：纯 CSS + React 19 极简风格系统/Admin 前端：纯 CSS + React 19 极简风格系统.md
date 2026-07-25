---
kind: frontend_style
name: Admin 前端：纯 CSS + React 19 极简风格系统
category: frontend_style
scope:
    - '**'
source_files:
    - admin/package.json
    - admin/vite.config.ts
    - admin/src/index.css
    - admin/src/App.tsx
    - admin/src/pages/Dashboard.tsx
    - admin/src/pages/Agents.tsx
    - admin/src/pages/RequestLog.tsx
    - admin/src/pages/Calibration.tsx
    - admin/src/pages/JobsWatch.tsx
    - admin/src/api.ts
    - scripts/build-admin-embedded.ts
---

## 体系概览
- 技术栈：Vite 6 + @vitejs/plugin-react + React 19 + TypeScript，无 Tailwind、无 CSS-in-JS、无 UI 组件库。
- 样式方案：全局 CSS（admin/src/index.css）+ 少量内联 style；通过 CSS 自定义属性集中管理主题色、字体与间距。
- 构建产物：vite build 输出到 admin/dist/，并通过 base: '/admin/' 以子路径部署，最终被根仓库的 scripts/build-admin-embedded.ts 嵌入到 gbrain CLI 二进制中。

## 关键文件与包
- admin/package.json：仅声明 React 19 运行时与 Vite 工具链，无任何第三方 UI 依赖。
- admin/vite.config.ts：启用 React 插件、设置路由前缀 /admin/、清理输出目录。
- admin/src/index.css：唯一的全局样式入口，定义设计令牌（颜色、字体）、布局（sidebar/main）、通用原子类（badge、btn、modal、drawer、table、tabs 等）以及移动端适配断点。
- admin/src/App.tsx：基于 hash 路由的最小 SPA shell，组合 Dashboard / Agents / RequestLog / Calibration / JobsWatch 页面。
- admin/src/pages/*.tsx：各功能页按单文件一组件组织，复用 index.css 中的原子类名。
- admin/src/api.ts：封装对 gbrain 后端的管理 API 调用。
- admin/index.html：SPA 入口 HTML。
- 根级脚本 scripts/build-admin-embedded.ts：将 admin/dist 打包进 gbrain 可执行文件，使 admin 作为内置静态资源随 CLI 分发。

## 架构与约定
- 无组件库：所有交互控件（按钮、表格、模态框、抽屉、标签、分页、过滤栏、警告条等）均以 CSS 类在 index.css 中统一实现，页面组件直接引用这些类名。
- 设计令牌集中化：所有颜色、字体族、字号、行高均通过 --bg-*、--text-*、--accent、--font-sans、--font-mono 等 CSS 变量暴露，便于整体换肤或对比度调整（例如注释记录了 WCAG AA 对比度升级）。
- 布局模式：固定侧边栏 + 主内容区（.app > .sidebar + .main），移动端通过 @media (max-width: 768px) 隐藏侧边栏并让 drawer 全宽。
- 路由策略：使用 URL hash（#dashboard、#agents、#log、#calibration、#jobs）驱动页面切换，不引入 react-router 等路由库。
- 样式粒度：优先使用预置原子类（如 .btn-primary、.badge-success、.modal-overlay），仅在布局微调处使用内联 style，避免在 JSX 中写大量 CSS-in-JS。

## 开发者应遵循的规则
1. 新增视觉元素时：先在 admin/src/index.css 中以 CSS 变量和原子类形式定义，再在组件中通过 className 引用，不要直接在 JSX 里写长串 style。
2. 主题扩展：只允许修改 :root 下的 CSS 变量，禁止在组件中硬编码颜色值。
3. 响应式：沿用现有 @media (max-width: 768px) 断点策略，保持 sidebar/main/drawer 的行为一致。
4. 路由：新增页面需在 App.tsx 的 Page 联合类型、hash 监听与条件渲染分支中同步注册，并在侧边栏导航中添加对应项。
5. 构建与嵌入：任何改动需通过 bun run -C admin build 验证产出，并确保 scripts/build-admin-embedded.ts 能正确将其注入 gbrain 二进制。