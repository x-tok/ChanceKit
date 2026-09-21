import { app, BrowserWindow } from 'electron';
import { printWebpagePdf } from '../../electron/webpage-pdf-printer';
import { WebpagePdfStore } from '../../electron/core/materials/webpage-pdf';

Object.assign(globalThis, { webpagePdfTest: { printWebpagePdf, WebpagePdfStore } });
app.whenReady().then(() => new BrowserWindow({ show: false }));
