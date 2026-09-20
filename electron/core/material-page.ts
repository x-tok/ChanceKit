import { parse } from 'acorn';
import { parseHTML } from 'linkedom';

function richText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(part => typeof part?.text === 'string' ? [part.text] : []).join('\n');
}

function publicFormSnapshot(script: string): Record<string, any> | undefined {
  if (!script.includes('window.formMetaContent')) return;
  try {
    // Read only a literal Snapshot property. Never execute page JavaScript.
    for (const statement of parse(script, { ecmaVersion: 'latest' }).body) {
      if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'AssignmentExpression') continue;
      const { left, right, operator } = statement.expression;
      if (operator !== '=' || left.type !== 'MemberExpression' || left.computed
        || left.object.type !== 'Identifier' || left.object.name !== 'window'
        || left.property.type !== 'Identifier' || left.property.name !== 'formMetaContent') continue;
      const object = right.type === 'CallExpression' && right.callee.type === 'Identifier'
        && right.callee.name === 'Object' && right.arguments.length === 1 ? right.arguments[0] : right;
      if (object.type !== 'ObjectExpression') continue;
      for (const property of object.properties) {
        if (property.type !== 'Property' || property.computed || property.kind !== 'init') continue;
        const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'Literal' ? property.key.value : '';
        if (key === 'Snapshot' && property.value.type === 'Literal' && typeof property.value.value === 'string') {
          const snapshot = JSON.parse(property.value.value);
          if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) return snapshot;
        }
      }
    }
  } catch { /* Nonliteral or malformed page data is not a readable form snapshot. */ }
}

export function readMaterialPage(html: string, url: string) {
  const { document } = parseHTML(html);
  const form = /(^|\.)feishu\.cn$/i.test(new URL(url).hostname)
    ? [...document.querySelectorAll('script')].map(script => publicFormSnapshot(script.textContent ?? '')).find(Boolean) : undefined;
  const title = document.querySelector('#activity-name')?.textContent?.trim()
    || document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim()
    || document.querySelector('title')?.textContent?.trim() || '';
  if (form && typeof form.name === 'string' && Array.isArray(form.viewProperty?.fields) && form.fieldMap) {
    const text = [form.name, richText(form.description)];
    for (const id of form.viewProperty.fields.slice(0, 100)) {
      const field = form.fieldMap[id];
      const info = form.viewProperty.fieldInfos?.[id];
      if (!field || info?.visible === false) continue;
      text.push(String(info?.title ?? field.name ?? ''), richText(info?.description ?? field.description));
      for (const option of (field.property?.options ?? []).slice(0, 300)) {
        if (typeof option.name === 'string') text.push(option.name);
      }
    }
    return { title: form.name, text: text.filter(Boolean).join('\n'), images: [] as string[], links: [] as string[], restricted: false };
  }
  for (const element of document.querySelectorAll('script,style,noscript,iframe,nav,footer,svg,[hidden],[aria-hidden="true"]')) element.remove();
  const article = document.querySelector('#js_content,article,main,[role="main"]');
  const root = article ?? document.body;
  const images = [...root.querySelectorAll('img')].map(image => image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('src')).filter(Boolean) as string[];
  const links = [...root.querySelectorAll('a[href]')].map(a => a.getAttribute('href')!);
  for (const element of root.querySelectorAll('p,div,li,h1,h2,h3,h4,br,tr,option')) element.appendChild(document.createTextNode('\n'));
  const text = root.textContent?.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() ?? '';
  const challengePath = /\/(?:wappoc_appmsgcaptcha|captcha|login)(?:[/.?]|$)/i.test(new URL(url).pathname);
  const challengeText = /登录后(查看|继续)|请先登录|完成验证后|访问过于频繁|安全验证|captcha|enable javascript/i;
  const restricted = challengePath || (text.length < 1500 && challengeText.test(`${title} ${text}`)
    && (!article || /^(环境异常|安全验证|请先登录|登录|验证码|captcha)$/i.test(title)));
  return { title, text, images, links, restricted };
}
