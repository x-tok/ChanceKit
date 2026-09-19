import { chromium } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageCircle } from 'lucide-react';
import { mkdir, writeFile } from 'node:fs/promises';

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  const svg = renderToStaticMarkup(createElement(MessageCircle, { size: 296, color: '#d7f0e0', strokeWidth: 1.4 }));
  const png = await page.evaluate(async source => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#253e30'; ctx.beginPath(); ctx.roundRect(20, 20, 472, 472, 104); ctx.fill();
    const image = new Image();
    image.src = 'data:image/svg+xml;base64,' + btoa(source);
    await image.decode(); ctx.drawImage(image, 108, 100, 296, 296);
    ctx.fillStyle = '#82b895'; ctx.fillRect(215, 224, 82, 14); ctx.fillRect(215, 260, 54, 14);
    return canvas.toDataURL('image/png').split(',')[1];
  }, svg);
  await mkdir('build', { recursive: true });
  await writeFile('build/icon.png', Buffer.from(png, 'base64'));
} finally { await browser.close(); }
