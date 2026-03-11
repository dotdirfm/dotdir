import './index.css';

import { initBridge } from './bridge';
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { App } from './app';

await initBridge();

const container = document.getElementById('app');
const root = createRoot(container!);
root.render(createElement(App));
