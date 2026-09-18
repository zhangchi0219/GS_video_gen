import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SplatViewer } from './SplatViewer';
// 顺序要紧：tokens 定义值 → base 消费它们做元素默认样式 → app 是本组件的层
import './tokens.css';
import './base.css';
import './app.css';

// 开着 StrictMode：React 19 在开发模式下会把 effect 挂载两次，
// 正好逼出 WebGL 资源没有正确 dispose 的问题（这类泄漏在 splat 场景里代价很大）。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SplatViewer />
  </StrictMode>,
);
