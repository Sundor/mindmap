#!/usr/bin/env node
// Browser smoke test of the built viewer, opened from file:// in headless Edge or Chrome and
// driven with real mouse and keyboard input through the DevTools protocol.
//
// Uses Node built-ins only (child_process, fetch, WebSocket: Node 22+). No test framework and
// no browser-automation dependency.
//
// Usage: npm run build && npm run smoke
//        node scripts/smoke-cdp.mjs [path/to/viewer.html]
// The browser is found in the usual install locations; set BROWSER to the path of msedge.exe /
// chrome(.exe) to override. Exit code 0 when every check passes, 1 otherwise, 2 when no browser
// was found or it could not be started.
//
// The browser profile is one directory in the temp directory, used by every run and emptied
// before and after each (see `prepareProfile`).
//
// The run is offline: the browser is started with its own network use switched off and with no
// name resolution (`OFFLINE_FLAGS`), and the last checks are that the page asked for nothing
// outside its folder and that its Content Security Policy would have stopped it.
//
// It expects the shipped example (examples/architecture.yaml) as architecture.yaml and the dummy
// work items (fixtures/workitems.json) as workitems.json next to the viewer. A page opened from
// disk cannot read them by itself: the run drops them on the page the way a user would from the
// file manager, which gives the page references to the files (the recent maps are built on them).
//
// Set SMOKE_SHOT to a .png path to get one screenshot of the work items drawn on the map (the
// Everything level, Stories + Tasks, a story selected); SMOKE_SHOT_SHRUNK for one of the shrunk
// collapsed groups.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const BROWSERS = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

const TIMEOUT_MS = 15000;

/**
 * @typedef {object} Cdp
 * @property {(method: string, params?: Record<string, unknown>) => Promise<any>} send
 * @property {(event: string, handler: (params: any) => void) => void} on
 * @property {() => void} close
 */

/**
 * Minimal DevTools-protocol client over one WebSocket.
 * @param {string} url
 * @returns {Promise<Cdp>}
 */
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), {
      once: true,
    });
  });
  let nextId = 0;
  /** @type {Map<number, { resolve: (value: unknown) => void, reject: (reason: Error) => void }>} */
  const pending = new Map();
  /** @type {Map<string, ((params: any) => void)[]>} */
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    // An event of the browser (no ID), not the answer to a command.
    if (message.id === undefined) {
      for (const handler of listeners.get(message.method) ?? []) handler(message.params);
      return;
    }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const waiting of pending.values()) waiting.reject(new Error('the browser went away'));
    pending.clear();
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        // A command the browser never answers must fail the run, not hang it.
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`no answer to ${method} ${JSON.stringify(params).slice(0, 200)}`));
        }, TIMEOUT_MS);
        pending.set(id, {
          resolve: (value) => (clearTimeout(timer), resolve(value)),
          reject: (reason) => (clearTimeout(timer), reject(reason)),
        });
      });
    },
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
    close: () => socket.close(),
  };
}

/** Start of the console line by which the page reports a violation of its security policy. */
const VIOLATION_MARK = 'smoke-policy-violation ';

/**
 * Keeps the browser itself off the network: no update checks, no sync, no reporting — and no
 * host name resolves, so a request to another server could not be answered even if one were made.
 */
const OFFLINE_FLAGS = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-client-side-phishing-detection',
  '--disable-domain-reliability',
  '--disable-breakpad',
  '--metrics-recording-only',
  '--no-pings',
  '--host-resolver-rules=MAP * ~NOTFOUND',
];

/**
 * Run in the page at the end: tries what the Content Security Policy must stop —
 * code from a string, an injected script, and a script, an image and a `fetch` from another
 * server — and reports what happened and which directives objected.
 */
const POLICY_PROBE = `(async () => {
  const directives = new Set();
  const note = (event) => directives.add(event.effectiveDirective);
  document.addEventListener('securitypolicyviolation', note);
  let evalRan = false;
  try { evalRan = new Function('return true')(); } catch {}
  const inline = document.createElement('script');
  inline.textContent = 'window.__smokeInlineRan = true';
  document.head.append(inline);
  const outside = document.createElement('script');
  outside.src = 'https://offline-check.invalid/x.js';
  document.head.append(outside);
  // A script file next to the page: the load event would say it was fetched and run.
  const beside = document.createElement('script');
  const besideRan = new Promise((resolve) => {
    beside.onload = () => resolve(true);
    beside.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 1500);
  });
  beside.src = './architecture.yaml';
  document.head.append(beside);
  new Image().src = 'https://offline-check.invalid/x.png';
  const fetched = await fetch('https://offline-check.invalid/x').then(() => 'answered', () => 'failed');
  await new Promise((resolve) => setTimeout(resolve, 300));
  document.removeEventListener('securitypolicyviolation', note);
  inline.remove();
  outside.remove();
  beside.remove();
  return { evalRan, inlineRan: window.__smokeInlineRan === true, besideRan: await besideRan, fetched, directives: [...directives].sort() };
})()`;

/**
 * @param {() => Promise<T | undefined | null | false>} probe
 * @param {string} what
 * @returns {Promise<T>}
 * @template T
 */
async function waitFor(probe, what) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Functions evaluated in the page; kept as source text. */
const PAGE_HELPERS = `
  window.__smoke = {
    app: () => document.querySelector('.app'),
    attr: (name) => document.querySelector('.app')?.getAttribute(name) ?? null,
    count: (selector) => document.querySelectorAll(selector).length,
    viewport: () => {
      const style = document.querySelector('.react-flow__viewport')?.style.transform ?? '';
      const m = /translate\\(([-\\d.e]+)px,\\s*([-\\d.e]+)px\\)\\s*scale\\(([-\\d.e]+)\\)/.exec(style);
      return m ? { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) } : null;
    },
    // A point of the element that a real click would hit (not covered by something else).
    clickPoint: (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      // The detail panel and the tabs of the control panel scroll; the canvas must not be
      // scrolled by this.
      if (el.closest('.detail-body, .cp-panels')) el.scrollIntoView({ block: 'nearest' });
      const hits = (x, y) => {
        const top = document.elementFromPoint(x, y);
        return top !== null && (el === top || el.contains(top));
      };
      if (el instanceof SVGGElement) {
        const line = el.querySelector('.react-flow__edge-interaction') ?? el.querySelector('path');
        const length = line.getTotalLength();
        const matrix = line.getScreenCTM();
        for (let i = 1; i < 40; i++) {
          const p = line.getPointAtLength((length * i) / 40).matrixTransform(matrix);
          if (hits(p.x, p.y)) return { x: p.x, y: p.y };
        }
        return null;
      }
      const r = el.getBoundingClientRect();
      for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.15], [0.2, 0.5], [0.8, 0.5], [0.5, 0.85], [0.1, 0.1], [0.9, 0.9]]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (hits(x, y)) return { x, y };
      }
      return null;
    },
    // The ID of the tab of the control panel to click so that the element is shown: null when
    // it is on the tab shown, or in no tab. Never the tab shown in an open body: a click on that
    // one would collapse the body.
    tabFor: (selector) => {
      const panel = document.querySelector(selector)?.closest('[role="tabpanel"]');
      if (!panel) return null;
      const collapsed = window.__smoke.attr('data-panel-collapsed') === 'true';
      return panel.hidden || collapsed ? panel.getAttribute('aria-labelledby') : null;
    },
    // The tabs of the control panel and their panels, as the page states them: which tab is
    // selected, which cannot be chosen, whether each names its panel and is named by it, and
    // which panels are on screen.
    tabs: () => {
      const tabs = [...document.querySelectorAll('#control-panel [role="tablist"] [role="tab"]')];
      const panels = [...document.querySelectorAll('#control-panel [role="tabpanel"]')];
      return {
        tabs: tabs.map((tab) => tab.id),
        selected: tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').map((tab) => tab.id),
        disabled: tabs.filter((tab) => tab.getAttribute('aria-disabled') === 'true').map((tab) => tab.id),
        paired: tabs.every((tab) => {
          const panel = document.getElementById(tab.getAttribute('aria-controls'));
          return panel?.getAttribute('role') === 'tabpanel' && panel.getAttribute('aria-labelledby') === tab.id;
        }),
        panels: panels.length,
        shown: panels.filter((panel) => panel.getClientRects().length > 0).map((panel) => panel.id),
        tab: window.__smoke.attr('data-panel-tab'),
        collapsed: window.__smoke.attr('data-panel-collapsed'),
        active: document.activeElement?.id ?? null,
      };
    },
    // A point of the canvas with nothing but the empty pane under it.
    emptyPoint: () => {
      const r = document.querySelector('.react-flow').getBoundingClientRect();
      for (let fy = 0.02; fy < 1; fy += 0.04) {
        for (let fx = 0.02; fx < 1; fx += 0.04) {
          const x = r.left + r.width * fx;
          const y = r.top + r.height * fy;
          if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
        }
      }
      return null;
    },
    // Points along the visible line of an edge that a click can reach: on the canvas and with
    // an edge's line or hit area on top (not a node, a label or a panel).
    edgePoints: (id) => {
      const el = document.querySelector('.react-flow__edge[data-id="' + id + '"]');
      const line = el?.querySelector('.react-flow__edge-path');
      const canvas = document.querySelector('.react-flow')?.getBoundingClientRect();
      if (!line || !canvas) return [];
      const length = line.getTotalLength();
      const matrix = line.getScreenCTM();
      const points = [];
      for (let i = 1; i <= 37; i++) {
        const p = line.getPointAtLength((length * i) / 38).matrixTransform(matrix);
        if (p.x <= canvas.left || p.x >= canvas.right || p.y <= canvas.top || p.y >= canvas.bottom) continue;
        if (document.elementFromPoint(p.x, p.y)?.closest('.react-flow__edge')) points.push({ x: p.x, y: p.y });
      }
      return points;
    },
    edgeIds: () => [...document.querySelectorAll('.react-flow__edge')].map((e) => e.dataset.id),
    // The IDs of the nodes drawn (the row bands are none), sorted; "only" narrows the selector.
    nodeIds: (only = '') =>
      [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-band)' + only)].map((n) => n.dataset.id).sort(),
    nodesOnCanvas: () => {
      const c = document.querySelector('.react-flow').getBoundingClientRect();
      return [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-band)')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top;
      }).length;
    },
    // The boxes that hold no other box (leaves, closed groups) and lie partly under the minimap,
    // and whether the whole map ends beside the minimap or above it.
    underMinimap: () => {
      const minimap = document.querySelector('.react-flow__minimap').getBoundingClientRect();
      const boxes = [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-band)')].map((el) => ({ id: el.dataset.id, r: el.getBoundingClientRect() }));
      const holds = (a, b) => a !== b && b.r.left >= a.r.left && b.r.right <= a.r.right && b.r.top >= a.r.top && b.r.bottom <= a.r.bottom;
      const under = boxes
        .filter((a) => !boxes.some((b) => holds(a, b)))
        .filter(({ r }) => Math.min(r.right, minimap.right) - Math.max(r.left, minimap.left) > 1 && Math.min(r.bottom, minimap.bottom) - Math.max(r.top, minimap.top) > 1)
        .map(({ id }) => id);
      const all = [...document.querySelectorAll('.react-flow__node')].map((el) => el.getBoundingClientRect());
      const right = Math.max(...all.map((r) => r.right));
      const bottom = Math.max(...all.map((r) => r.bottom));
      return { under, clear: right <= minimap.left + 1 || bottom <= minimap.top + 1 };
    },
    // The nodes drawn that are not entirely on the canvas (none, when the map is fitted into it).
    offCanvas: () => {
      const c = document.querySelector('.react-flow').getBoundingClientRect();
      return [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-band)')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1;
      }).map((el) => el.dataset.id);
    },
    // The viewport kept in the browser for the structure, as the text that is stored.
    storedViewport: () => {
      const key = Object.keys(localStorage).find((k) => k.startsWith('architecture-map.viewport:'));
      return key === undefined ? null : localStorage.getItem(key);
    },
    // Shrunk closed groups whose box is too small for what it holds (none should be): the
    // list of names or the name cut off, in either direction, or names left out ("+k more").
    compactOverflow: () =>
      [...document.querySelectorAll('.arch-group.arch-compact')].flatMap((box) => {
        const id = box.closest('.react-flow__node')?.dataset.id ?? '?';
        const body = box.querySelector('.arch-collapsed-body');
        const text = box.querySelector('.arch-collapsed-text');
        const name = box.querySelector('.arch-node-name');
        const problems = [];
        if (!body || !name || !text) return [id + ': incomplete'];
        if (body.scrollHeight > body.clientHeight) problems.push('list ' + body.scrollHeight + ' > ' + body.clientHeight + ' high');
        if (body.scrollWidth > body.clientWidth) problems.push('list ' + body.scrollWidth + ' > ' + body.clientWidth + ' wide');
        if (name.scrollWidth > name.clientWidth) problems.push('name ' + name.scrollWidth + ' > ' + name.clientWidth + ' wide');
        if (name.scrollHeight > name.clientHeight) problems.push('name ' + name.scrollHeight + ' > ' + name.clientHeight + ' high');
        if (box.scrollHeight > box.clientHeight || box.scrollWidth > box.clientWidth) problems.push('box overflows');
        if (/\\+\\d+ more$/.test(text.textContent)) problems.push('names left out');
        return problems.length > 0 ? [id + ': ' + problems.join(', ')] : [];
      }),
    // The minimap in screen pixels: its box, the box of one node in it and the viewport
    // rectangle (as drawn, before the SVG cuts it off).
    minimap: (nodeId) => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const svg = document.querySelector('#minimap');
      return {
        svg: box(svg),
        node: box(svg?.querySelector('.react-flow__minimap-node[data-id="' + nodeId + '"]')),
        view: box(svg?.querySelector('.arch-minimap-viewport')),
        nodes: svg?.querySelectorAll('.react-flow__minimap-node').length ?? 0,
      };
    },
    // What is wrong with the work items as drawn (nothing should be): a list higher or wider
    // than the block reserved for it, a block or a line outside the box of its node, a line of
    // another height than reserved, a task text that does not fit (it is short by design).
    workItemProblems: () => {
      const problems = [];
      for (const block of document.querySelectorAll('.arch-workitems')) {
        // The list of an open group is drawn above the edges, outside its node's element.
        const node =
          block.closest('.react-flow__node') ??
          document.querySelector('.react-flow__node[data-id="' + block.dataset.nodeId + '"]');
        const id = node?.dataset.id ?? '?';
        const box = node.getBoundingClientRect();
        const zoom = box.width / node.offsetWidth;
        const slack = 0.6 * zoom;
        const inside = (r) =>
          r.left >= box.left - slack && r.right <= box.right + slack &&
          r.top >= box.top - slack && r.bottom <= box.bottom + slack;
        if (block.scrollHeight > block.clientHeight) problems.push(id + ': list ' + block.scrollHeight + ' > ' + block.clientHeight + ' high');
        if (block.scrollWidth > block.clientWidth) problems.push(id + ': list ' + block.scrollWidth + ' > ' + block.clientWidth + ' wide');
        if (!inside(block.getBoundingClientRect())) problems.push(id + ': block outside its node');
        const name = node.querySelector('.arch-node-name')?.getBoundingClientRect();
        const top = block.getBoundingClientRect().top;
        if (name && name.bottom > top + slack) problems.push(id + ': the name overlaps the list');
        for (const line of block.querySelectorAll('.arch-workitem, .arch-workitem-more, .arch-badge')) {
          const what = id + ' #' + (line.dataset.workitemId ?? line.className);
          if (!inside(line.getBoundingClientRect())) problems.push(what + ': outside its node');
          const text = line.querySelector('.arch-workitem-text');
          if (line.dataset.lineKind === 'task' && text.scrollWidth > text.clientWidth) problems.push(what + ': task text cut off');
        }
        const lines = block.querySelectorAll(':scope > li');
        const heights = new Set([...lines].map((li) => li.offsetHeight));
        if (heights.size > 1) problems.push(id + ': lines of heights ' + [...heights].join('/'));
      }
      // Badges of closed groups stay inside their box too.
      for (const badge of document.querySelectorAll('.arch-collapsed-body .arch-badge')) {
        const box = badge.closest('.arch-node').getBoundingClientRect();
        const r = badge.getBoundingClientRect();
        if (r.left < box.left || r.right > box.right || r.top < box.top || r.bottom > box.bottom) {
          problems.push((badge.closest('.react-flow__node')?.dataset.id ?? '?') + ': badge outside its group');
        }
      }
      return problems;
    },
    // What lies on the work-item lines (nothing should): an edge on top of a line, found by
    // asking for the element at points along the line, and an edge label over the icon or the
    // text of a line (labels take no pointer events, so their boxes are compared).
    workItemCover: () => {
      const problems = [];
      const labels = [...document.querySelectorAll('.arch-edge-label')].map((label) => ({
        id: label.dataset.edgeId,
        rect: label.getBoundingClientRect(),
      }));
      const lines = document.querySelectorAll('.arch-workitem');
      for (const line of lines) {
        const what = '#' + line.dataset.workitemId;
        const r = line.getBoundingClientRect();
        let edges = 0;
        for (let i = 0; i < 20; i++) {
          const x = r.left + (r.width * (i + 0.5)) / 20;
          const top = document.elementFromPoint(x, r.top + r.height / 2);
          if (top?.closest('.react-flow__edge')) edges += 1;
        }
        if (edges > 0) problems.push(what + ': an edge on ' + edges * 5 + '% of the line');
        const text = line.querySelector('.arch-workitem-text');
        const icon = line.querySelector('.wi-icon')?.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(text);
        const drawn = range.getBoundingClientRect();
        const box = text.getBoundingClientRect();
        const left = Math.min(icon?.left ?? box.left, box.left);
        const right = Math.min(drawn.right, box.right);
        for (const label of labels) {
          const w = Math.min(right, label.rect.right) - Math.max(left, label.rect.left);
          const h = Math.min(r.bottom, label.rect.bottom) - Math.max(r.top, label.rect.top);
          if (w > 0.5 && h > 0.5) problems.push(what + ': label of ' + label.id + ' over ' + Math.round(w) + 'x' + Math.round(h));
        }
      }
      return { lines: lines.length, labels: labels.length, problems };
    },
    // How far the middle of the element is from the middle of the canvas, in pixels.
    centreOffset: (selector) => {
      const el = document.querySelector(selector);
      const canvas = document.querySelector('.react-flow');
      if (!el || !canvas) return null;
      const r = el.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      return {
        dx: Math.round(r.left + r.width / 2 - (c.left + c.width / 2)),
        dy: Math.round(r.top + r.height / 2 - (c.top + c.height / 2)),
      };
    },
    // Opens a file through one of the two file inputs, as the picker would.
    openFile: (input, name, content) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([content], name));
      const el = document.querySelector(input);
      el.files = transfer.files;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    // Chooses an option of a select, as a pick from its list would.
    choose: (selector, value) => {
      const select = document.querySelector(selector);
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    },
    // Waits until the page shows what an action just changed ("done" holds), and for no longer:
    // it gives way to nothing that needs a frame or a timer, so no layout arrives meanwhile.
    // For what the page shows between an action and the map that follows it.
    rendered: async (done) => {
      for (let turn = 0; turn < 50 && !done(); turn++) await null;
      return done();
    },
    // True when some of the element is on the canvas.
    partlyOnScreen: (selector) => {
      const el = document.querySelector(selector);
      const canvas = document.querySelector('.react-flow');
      if (!el || !canvas) return false;
      const r = el.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      return r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top;
    },
    text: (selector) => document.querySelector(selector)?.textContent ?? null,
    onScreen: (selector) => {
      const el = document.querySelector(selector);
      const canvas = document.querySelector('.react-flow');
      if (!el || !canvas) return false;
      const r = el.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      return r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1;
    },
    // What is on screen in one frame: the arrangement and level drawn, the zoom, the middle of
    // the canvas, and the box of every node (left, top, width, height).
    frame: () => {
      const c = document.querySelector('.react-flow').getBoundingClientRect();
      const boxes = {};
      for (const el of document.querySelectorAll('.react-flow__node:not(.react-flow__node-band)')) {
        const r = el.getBoundingClientRect();
        boxes[el.dataset.id] = [r.left, r.top, r.width, r.height];
      }
      return {
        arrangement: window.__smoke.attr('data-arrangement'),
        lod: window.__smoke.attr('data-lod'),
        zoom: window.__smoke.viewport()?.zoom ?? null,
        mid: { x: c.left + c.width / 2, y: c.top + c.height / 2 },
        boxes,
      };
    },
    // Records, frame by frame, each change of the arrangement: the last frame before it and up
    // to 40 frames after it, until arrangementChanges() is asked. The first frame before is the
    // one at the call, so a change that comes before the next frame is not missed.
    watchArrangement: () => {
      const watch = { changes: [], stopped: false };
      window.__smokeArrangement = watch;
      let last = window.__smoke.frame();
      const step = () => {
        if (watch.stopped) return;
        const now = window.__smoke.frame();
        const current = watch.changes[watch.changes.length - 1];
        if (now.arrangement !== last.arrangement) watch.changes.push({ before: last, after: [now] });
        else if (current && current.after.length < 40) current.after.push(now);
        last = now;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      return true;
    },
    arrangementChanges: () => {
      const watch = window.__smokeArrangement;
      if (!watch) return [];
      watch.stopped = true;
      window.__smokeArrangement = null;
      return watch.changes;
    },
    // The box of every node drawn in the coordinates of the canvas, from its own transform:
    // the same whatever the view.
    canvasBoxes: () =>
      Object.fromEntries(
        [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-band)')].map((el) => {
          const m = /translate\\(([-\\d.e]+)px,\\s*([-\\d.e]+)px\\)/.exec(el.style.transform);
          return [el.dataset.id, m ? [Number(m[1]), Number(m[2]), el.offsetWidth, el.offsetHeight] : null];
        }),
      ),
    // The boxes drawn that overlap a box neither inside nor around them, or that stick out of
    // the group they are in (an ID names its group: "a.b" lies in "a").
    layoutProblems: () => {
      const boxes = [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-band)')].map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.id, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
      const byId = new Map(boxes.map((box) => [box.id, box]));
      const problems = [];
      for (const box of boxes) {
        const parent = byId.get(box.id.split('.').slice(0, -1).join('.'));
        if (parent && (box.left < parent.left - 0.5 || box.right > parent.right + 0.5 || box.top < parent.top - 0.5 || box.bottom > parent.bottom + 0.5)) {
          problems.push(box.id + ' outside ' + parent.id);
        }
      }
      const nested = (a, b) => a.id.startsWith(b.id + '.') || b.id.startsWith(a.id + '.');
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          if (nested(a, b)) continue;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 0.5 && h > 0.5) problems.push(a.id + ' overlaps ' + b.id);
        }
      }
      return problems;
    },
    // The groups drawn open whose chevron can be clicked: their box on screen, whether all of
    // it is on the canvas, and how far its middle is from the middle of the canvas.
    openGroups: () => {
      const c = document.querySelector('.react-flow').getBoundingClientRect();
      return [...document.querySelectorAll('.react-flow__node-group')]
        .filter((el) => el.querySelector('.arch-chevron[aria-expanded="true"]:not(:disabled)'))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            id: el.dataset.id,
            left: r.left,
            onCanvas: r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom,
            // Nothing (a legend, a panel) lies over its chevron.
            clickable: window.__smoke.clickPoint('.react-flow__node[data-id="' + el.dataset.id + '"] .arch-chevron') !== null,
            distance: Math.hypot(r.left + r.width / 2 - (c.left + c.width / 2), r.top + r.height / 2 - (c.top + c.height / 2)),
            canvasWidth: c.width,
          };
        });
    },
    // Clicks the element at the very moment another canvas has been put into the page; whether
    // that has happened is said by newCanvasClicked().
    clickOnNewCanvas: (selector) => {
      const old = document.querySelector('#map-canvas');
      window.__smokeNewCanvas = false;
      const seen = new MutationObserver(() => {
        const now = document.querySelector('#map-canvas');
        if (!now || now === old) return;
        seen.disconnect();
        document.querySelector(selector)?.click();
        window.__smokeNewCanvas = true;
      });
      seen.observe(document.querySelector('.app'), { childList: true, subtree: true });
      return true;
    },
    newCanvasClicked: () => window.__smokeNewCanvas === true,
    // The boxes drawn that are no open group: leaves and closed groups.
    closedBoxes: () =>
      [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-band)')]
        .filter((el) => !el.querySelector('.arch-chevron[aria-expanded="true"]'))
        .map((el) => el.dataset.id),
    // Every end of every edge that can be pointed at: the box it is attached to, the points of a
    // walk out of that box onto the line in steps of a pixel — from "inside" pixels inside the
    // box, at right angles to the side the line is attached to, to "outside" pixels along the
    // line, never past its middle — and what lies under each of them: "box", "edge", "list" (the
    // work-item list of an open group, drawn over the edges), the ID of another box, "pane" (the
    // empty canvas) or "covered" (something lies over the canvas there).
    edgeEnds: (inside, outside) => {
      const ends = [];
      for (const el of document.querySelectorAll('.react-flow__edge')) {
        const path = el.querySelector('.react-flow__edge-path');
        if (!path || getComputedStyle(el).pointerEvents === 'none') continue;
        const [from, rest] = el.dataset.id.split('>');
        const to = rest.split(':')[0];
        const m = path.getScreenCTM();
        const at = (length) => {
          const p = path.getPointAtLength(length);
          return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
        };
        const total = path.getTotalLength();
        const scale = Math.hypot(m.a, m.b);
        for (const [box, start, sign] of [[from, 0, 1], [to, total, -1]]) {
          const rect = document.querySelector('.react-flow__node[data-id="' + box + '"]')?.getBoundingClientRect();
          if (!rect) continue;
          const end = at(start);
          // The side the line is attached to: the nearest one, with its direction out of the box.
          const [, nx, ny] = [
            [end.x - rect.left, -1, 0],
            [rect.right - end.x, 1, 0],
            [end.y - rect.top, 0, -1],
            [rect.bottom - end.y, 0, 1],
          ].reduce((a, b) => (Math.abs(b[0]) < Math.abs(a[0]) ? b : a));
          const points = [];
          const under = [];
          for (let t = -inside; t <= Math.min(outside, (total * scale) / 2); t++) {
            const on = t > 0 ? at(start + (sign * t) / scale) : { x: end.x + nx * t, y: end.y + ny * t };
            const x = Math.round(on.x);
            const y = Math.round(on.y);
            const hit = document.elementFromPoint(x, y);
            const node = hit?.closest('.react-flow__node:not(.react-flow__node-band)');
            points.push({ x, y });
            if (hit?.closest('.react-flow__edge')) under.push('edge');
            else if (node) under.push(node.dataset.id === box ? 'box' : node.dataset.id);
            else if (hit?.closest('.arch-workitems-above')) under.push('list');
            else under.push(hit?.classList.contains('react-flow__pane') ? 'pane' : 'covered');
          }
          ends.push({ edge: el.dataset.id, box, points, under });
        }
      }
      return ends;
    },
    // A drag of the empty canvas that moves the view by (dx, dy), or as far that way as the
    // canvas allows: where to press and where to let go.
    panPlan: (dx, dy) => {
      const c = document.querySelector('.react-flow').getBoundingClientRect();
      const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
      let best = null;
      for (let fy = 0.02; fy < 1; fy += 0.04) {
        for (let fx = 0.02; fx < 1; fx += 0.04) {
          const from = { x: c.left + c.width * fx, y: c.top + c.height * fy };
          if (!document.elementFromPoint(from.x, from.y)?.classList.contains('react-flow__pane')) continue;
          const to = { x: clamp(from.x + dx, c.left + 4, c.right - 4), y: clamp(from.y + dy, c.top + 4, c.bottom - 4) };
          const reach = Math.hypot(to.x - from.x, to.y - from.y);
          if (!best || reach > best.reach) best = { from, to, reach };
          if (to.x === from.x + dx && to.y === from.y + dy) return best;
        }
      }
      return best;
    },
    // The middle of the canvas, and whether the canvas is what lies there (not a panel).
    canvasMiddle: () => {
      const c = document.querySelector('.react-flow').getBoundingClientRect();
      const x = c.left + c.width / 2;
      const y = c.top + c.height / 2;
      return { x, y, onCanvas: !!document.elementFromPoint(x, y)?.closest('.react-flow') };
    },
    // The level drawn and whether it is settled, in every frame for "ms" milliseconds.
    levelsDuring: async (ms) => {
      const seen = new Set();
      const end = performance.now() + ms;
      do {
        seen.add(window.__smoke.attr('data-lod') + ' ' + window.__smoke.attr('data-level-settled'));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      } while (performance.now() < end);
      return [...seen];
    },
    // Resolves after two frames: what an input has changed is rendered by then.
    frames: () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))),
    // Marks the element of the canvas, to tell later whether it is still the same one.
    markCanvas: () => {
      const mark = Math.random().toString(36).slice(2);
      document.querySelector('.react-flow').__smokeMark = mark;
      return mark;
    },
    canvasMark: () => document.querySelector('.react-flow')?.__smokeMark ?? null,
    // How wide the map drawn is on screen, and the width of the canvas that nothing covers.
    mapSpread: () => {
      const c = document.querySelector('.react-flow').getBoundingClientRect();
      const panels = document.querySelector('.cp-panels');
      const covered = panels && panels.getClientRects().length > 0 ? Math.max(0, panels.getBoundingClientRect().right - c.left) : 0;
      const rects = [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-band)')].map((el) => el.getBoundingClientRect());
      const width = rects.length === 0 ? 0 : Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left));
      return { width, free: c.width - covered };
    },
    // Shrink collapsed groups as the checkbox shows it, and the setting stored.
    shrinkControl: () => {
      const box = document.querySelector('#compact-collapsed');
      return { checked: box?.checked ?? null, disabled: box?.disabled ?? null, stored: window.__smoke.attr('data-compact-collapsed') };
    },
    // The box of every node drawn on screen (the row bands are none): left, top, right, bottom.
    rects: () =>
      Object.fromEntries(
        [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-band)')].map((el) => {
          const r = el.getBoundingClientRect();
          return [el.dataset.id, [r.left, r.top, r.right, r.bottom]];
        }),
      ),
    // A point of the element where a press reaches the element itself: on the canvas, with the
    // element (or something inside it, but nothing matching "avoid") on top. The element is
    // walked along its longer side from its middle outwards, so that an edge of the map or a
    // box that crosses it is stepped over. Null when it is covered everywhere.
    pressPoint: (selector, avoid = '') => {
      const el = document.querySelector(selector);
      const canvas = document.querySelector('.react-flow')?.getBoundingClientRect();
      if (!el || !canvas) return null;
      const r = el.getBoundingClientRect();
      const wide = r.width >= r.height;
      for (const along of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.1, 0.9, 0.04, 0.96]) {
        for (const across of [0.5, 0.25, 0.75]) {
          const x = r.left + r.width * (wide ? along : across);
          const y = r.top + r.height * (wide ? across : along);
          if (x <= canvas.left + 2 || x >= canvas.right - 2 || y <= canvas.top + 2 || y >= canvas.bottom - 2) continue;
          const top = document.elementFromPoint(x, y);
          if (top === null || !(el === top || el.contains(top))) continue;
          if (avoid !== '' && top.closest(avoid)) continue;
          return { x, y };
        }
      }
      return null;
    },
    // How far the view has to be panned so that the point comes to lie on the canvas, clear of
    // its border: (0, 0) when it does.
    roomShift: (x, y) => {
      const c = document.querySelector('.react-flow').getBoundingClientRect();
      const margin = 24;
      const shift = (v, lo, hi) => Math.round(v < lo + margin ? lo + margin - v : v > hi - margin ? hi - margin - v : 0);
      return { dx: shift(x, c.left, c.right), dy: shift(y, c.top, c.bottom) };
    },
    // A point inside the box of the node where the empty pane lies: nothing of the node, of a
    // box in it or of an edge takes a press there. Null when there is none.
    panePointIn: (id) => {
      const el = document.querySelector('.react-flow__node[data-id="' + id + '"]');
      const canvas = document.querySelector('.react-flow')?.getBoundingClientRect();
      if (!el || !canvas) return null;
      const r = el.getBoundingClientRect();
      const steps = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88];
      for (const fy of steps) {
        for (const fx of steps) {
          const x = r.left + r.width * fx;
          const y = r.top + r.height * fy;
          if (x <= canvas.left + 2 || x >= canvas.right - 2 || y <= canvas.top + 2 || y >= canvas.bottom - 2) continue;
          if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
        }
      }
      return null;
    },
    // A point of the canvas with the empty pane under it that lies in the box of no node.
    outsidePoint: () => {
      const c = document.querySelector('.react-flow').getBoundingClientRect();
      const boxes = [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-band)')].map((el) => el.getBoundingClientRect());
      for (let fy = 0.02; fy < 1; fy += 0.04) {
        for (let fx = 0.02; fx < 1; fx += 0.04) {
          const x = c.left + c.width * fx;
          const y = c.top + c.height * fy;
          if (boxes.some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2)) continue;
          if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
        }
      }
      return null;
    },
    // Every node drawn, the row bands too: what it is (an open or a closed group, a leaf, a
    // band), its name, the resize controls in it ("line:right", "handle:top-left", …) and its grip.
    resizeHandles: () =>
      [...document.querySelectorAll('.react-flow__node')].map((el) => {
        const grip = el.querySelector('.arch-resize-grip');
        const group = el.classList.contains('react-flow__node-group');
        return {
          id: el.dataset.id,
          kind: el.classList.contains('react-flow__node-band')
            ? 'band'
            : !group
              ? 'leaf'
              : el.querySelector('.arch-node')?.dataset.collapsed === 'false'
                ? 'open'
                : 'closed',
          name: el.querySelector('.arch-node-name')?.textContent ?? null,
          controls: [...el.querySelectorAll('.arch-resize')]
            .map((control) => (control.classList.contains('line') ? 'line' : 'handle') + ':' + ['top', 'bottom', 'left', 'right'].filter((word) => control.classList.contains(word)).join('-'))
            .sort(),
          grip: grip ? { tag: grip.tagName, label: grip.getAttribute('aria-label') } : null,
        };
      }),
    // How the pointer is treated at a node: whether its wrapper is marked as moved by the title
    // bar alone, and the computed pointer-events and cursors of the wrapper, the header, the box.
    pointerRules: (id) => {
      const el = document.querySelector('.react-flow__node[data-id="' + id + '"]');
      if (!el) return null;
      const header = el.querySelector('.arch-group-header');
      const box = el.querySelector('.arch-node');
      return {
        titleDrag: el.classList.contains('arch-title-drag'),
        wrapper: getComputedStyle(el).pointerEvents,
        header: header ? getComputedStyle(header).pointerEvents : null,
        headerCursor: header ? getComputedStyle(header).cursor : null,
        boxCursor: box ? getComputedStyle(box).cursor : null,
      };
    },
    // What the browser keeps of the positions and sizes set by hand: the stored text, by key.
    byHandStored: () =>
      Object.fromEntries(
        Object.keys(localStorage)
          .filter((key) => key.startsWith('architecture-map.sizes:') || key.startsWith('architecture-map.positions:'))
          .sort()
          .map((key) => [key, localStorage.getItem(key)]),
      ),
    // The edges drawn that end at the node: their ID, the path as drawn, and where the line
    // starts and ends on screen.
    edgeEndsAt: (id) =>
      [...document.querySelectorAll('.react-flow__edge')].flatMap((el) => {
        const line = el.querySelector('.react-flow__edge-path');
        if (!line || !el.dataset.id.split(':')[0].split('>').includes(id)) return [];
        const matrix = line.getScreenCTM();
        const at = (length) => {
          const p = line.getPointAtLength(length).matrixTransform(matrix);
          return [p.x, p.y];
        };
        return [{ id: el.dataset.id, d: line.getAttribute('d'), ends: [at(0), at(line.getTotalLength())] }];
      }),
    // The heat strips and progress bars drawn: the figure of each, the figure of the node with
    // everything inside it, the tooltip, and the height of a strip in the pixels of the canvas.
    lensFigures: () => {
      const number = (value) => (value === undefined ? null : Number(value));
      return {
        strips: [...document.querySelectorAll('.arch-heat-left')].map((strip) => {
          const node = strip.closest('.react-flow__node');
          const scale = node.getBoundingClientRect().width / node.offsetWidth;
          return {
            id: node.dataset.id,
            heat: Number(strip.dataset.heat),
            all: number(strip.dataset.heatAll),
            height: Math.round((strip.getBoundingClientRect().height / scale) * 10) / 10,
            title: strip.title,
          };
        }),
        bars: [...document.querySelectorAll('.arch-progress')].map((bar) => ({
          id: bar.closest('.react-flow__node').dataset.id,
          done: Number(bar.dataset.done),
          total: Number(bar.dataset.total),
          doneAll: number(bar.dataset.doneAll),
          totalAll: number(bar.dataset.totalAll),
          title: bar.title,
        })),
      };
    },
    // The colour the grip of a group is drawn in, whether it is marked as resized, and what the
    // accent colour of the page computes to on the canvas.
    gripColour: (id) => {
      const grip = document.querySelector('.react-flow__node[data-id="' + id + '"] .arch-resize-grip');
      const canvas = document.querySelector('.map-canvas');
      if (!grip || !canvas) return null;
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent)';
      canvas.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return { colour: getComputedStyle(grip).color, accent, resized: grip.dataset.resized ?? null };
    },
    // The line a resize control draws on the border of its group (its ::after), as it is now.
    controlLine: (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const s = getComputedStyle(el, '::after');
      return {
        hovered: el.matches(':hover'),
        look: [s.content, s.display, s.visibility, s.opacity, s.width, s.height, s.backgroundColor, s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor, s.boxShadow].join(' | '),
      };
    },
    // The factor by which the resize controls are enlarged against the zoom: the custom
    // property on the canvas, or "" when it is not set.
    unzoom: () => document.querySelector('.map-canvas')?.style.getPropertyValue('--unzoom') ?? null,
  };
  true
`;

/** The policy an exported page declares (`EXPORT_PAGE_POLICY` in src/core/mapPage.ts). */
const EXPORT_PAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/**
 * Functions evaluated in the page for the checks of the exported files; kept as source text. It
 * is an expression: the object, made on its first use in a page. They compare nothing: each
 * returns what a file says and what the canvas shows, side by side. The SVG asked about is the
 * one last given to `load`.
 */
const EXPORT_HELPERS = `(window.__smokeExport ??= {
  doc: null,
  text: '',
  pictures: {},
  hidden: [],
  // A rectangle of the screen in pixels of the map: less the corner of the canvas, through the
  // inverse of the viewport.
  toMap: (r) => {
    const c = document.querySelector('.react-flow').getBoundingClientRect();
    const v = window.__smoke.viewport();
    return { x: (r.left - c.left - v.x) / v.zoom, y: (r.top - c.top - v.y) / v.zoom, width: r.width / v.zoom, height: r.height / v.zoom };
  },
  // The two numbers of "translate(x y)".
  shift: (transform) => {
    const text = transform ?? 'translate(NaN NaN)';
    return text.slice(text.indexOf('(') + 1, text.indexOf(')')).split(' ').map(Number);
  },
  // The numbers of the "d" of a path.
  numbers: (d) => (d ?? '').replace(/[MCLHVQZ,]/g, ' ').split(' ').filter(Boolean).map(Number),
  // A colour as a file writes it ("#rrggbb"), and as the browser computes one: "rgb(…)",
  // "rgba(…)" or "color(srgb …)". Channels 0–255, alpha 0–1.
  hex: (text) => ({ r: parseInt(text.slice(1, 3), 16), g: parseInt(text.slice(3, 5), 16), b: parseInt(text.slice(5, 7), 16), a: 1 }),
  rgba: (text) => {
    const parts = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')).replace('srgb', ' ').replace('/', ' ').split(/[ ,]+/).filter(Boolean).map(Number);
    const scale = text.startsWith('color(') ? 255 : 1;
    return { r: parts[0] * scale, g: parts[1] * scale, b: parts[2] * scale, a: parts[3] ?? 1 };
  },
  // The colour an element of a file is filled or drawn with, with its opacity.
  paint: (el, name) => {
    const colour = el?.getAttribute(name);
    return colour ? { ...window.__smokeExport.hex(colour), a: Number(el.getAttribute(name + '-opacity') ?? 1) } : null;
  },
  // Custom properties of the page as colours, as the browser computes them at this moment.
  palette: (names) => {
    const probe = document.createElement('span');
    document.body.append(probe);
    const colours = Object.fromEntries(names.map((name) => {
      probe.style.color = 'var(' + name + ')';
      return [name, window.__smokeExport.rgba(getComputedStyle(probe).color)];
    }));
    probe.remove();
    return colours;
  },
  // Reads an exported SVG and keeps it for the questions below.
  load: (text) => {
    const E = window.__smokeExport;
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = doc.documentElement;
    const ids = (name) => [...doc.querySelectorAll('g[' + name + ']')].map((g) => g.getAttribute(name));
    E.doc = doc;
    E.text = text;
    return {
      error: doc.querySelector('parsererror')?.textContent ?? null,
      root: root.localName,
      width: Number(root.getAttribute('width')),
      height: Number(root.getAttribute('height')),
      role: root.getAttribute('role'),
      title: doc.querySelector('svg > title')?.textContent ?? null,
      desc: doc.querySelector('svg > desc')?.textContent ?? null,
      background: E.paint(doc.querySelector('rect[data-part="background"]'), 'fill'),
      shift: E.shift(doc.querySelector('g[data-part="map"]')?.getAttribute('transform')),
      nodes: ids('data-node'),
      edges: ids('data-edge'),
      texts: [...doc.querySelectorAll('text')].map((el) => el.textContent),
      names: [...doc.querySelectorAll('g[data-node]')].map((g) => g.querySelector('text')?.textContent ?? ''),
    };
  },
  // The size the SVG has as an image.
  image: async () => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('the SVG is no image'));
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(window.__smokeExport.text);
    });
    return { width: image.naturalWidth, height: image.naturalHeight };
  },
  // What the SVG holds and what the canvas draws: boxes, shown edges, labels and row bands by
  // their IDs, the first text of every box beside its name, the parts of every edge, the words
  // of every label.
  contents: () => {
    const { doc } = window.__smokeExport;
    const newline = String.fromCharCode(10);
    const written = (name) => [...doc.querySelectorAll('g[' + name + ']')].map((g) => g.getAttribute(name));
    const drawn = (selector, read) => [...document.querySelectorAll(selector)].map(read);
    return {
      boxes: { picture: written('data-node'), canvas: drawn('.react-flow__node:not(.react-flow__node-band)', (el) => el.dataset.id) },
      edges: { picture: written('data-edge'), canvas: drawn('.react-flow__edge:not(.arch-quiet)', (el) => el.dataset.id) },
      labels: { picture: written('data-edge-label'), canvas: drawn('.arch-edge-label[data-edge-id]:not(.arch-quiet)', (el) => el.dataset.edgeId) },
      bands: { picture: written('data-band').length, canvas: document.querySelectorAll('.react-flow__node-band').length },
      names: [...doc.querySelectorAll('g[data-node]')].map((g) => {
        const id = g.getAttribute('data-node');
        return { id, first: g.querySelector('text')?.textContent ?? '', name: document.querySelector('.react-flow__node[data-id="' + id + '"] .arch-node-name')?.textContent ?? null };
      }),
      parts: [...doc.querySelectorAll('g[data-edge]')].map((g) => ({ id: g.getAttribute('data-edge'), lines: g.querySelectorAll('[data-part="line"]').length, heads: g.querySelectorAll('[data-part="head"]').length })),
      words: [...doc.querySelectorAll('g[data-edge-label]')].map((g) => {
        const id = g.getAttribute('data-edge-label');
        return { id, picture: [...g.querySelectorAll('text')].map((el) => el.textContent).join(newline), canvas: document.querySelector('.arch-edge-label[data-edge-id="' + id + '"]')?.textContent ?? null };
      }),
    };
  },
  // Where the SVG has its boxes, lines and labels, and where the canvas has them, in pixels of
  // the map: a box as x, y, width, height (and the two ends of its header), a line as the
  // numbers of its path, a label as the middle of its box and its size.
  places: () => {
    const E = window.__smokeExport;
    return {
      boxes: [...E.doc.querySelectorAll('g[data-node]')].map((g) => {
        const id = g.getAttribute('data-node');
        const rect = g.querySelector('rect[data-part="box"]');
        const el = document.querySelector('.react-flow__node[data-id="' + id + '"]');
        const at = el ? E.toMap(el.getBoundingClientRect()) : null;
        const header = E.numbers(g.querySelector('[data-part="header"]')?.getAttribute('d'));
        return {
          id,
          picture: [...E.shift(g.getAttribute('transform')), Number(rect?.getAttribute('width')), Number(rect?.getAttribute('height'))],
          canvas: at ? [at.x, at.y, at.width, at.height] : null,
          // Its path goes up its left end, along the top and down its right end: 13 numbers.
          header: header.length === 13 ? [header[0], header[10]] : null,
        };
      }),
      edges: [...E.doc.querySelectorAll('g[data-edge]')].map((g) => {
        const id = g.getAttribute('data-edge');
        const path = document.querySelector('.react-flow__edge[data-id="' + id + '"] .react-flow__edge-path');
        return { id, picture: E.numbers(g.querySelector('[data-part="line"]')?.getAttribute('d')), canvas: path ? E.numbers(path.getAttribute('d')) : null };
      }),
      labels: [...E.doc.querySelectorAll('g[data-edge-label]')].map((g) => {
        const id = g.getAttribute('data-edge-label');
        const [x, y] = E.shift(g.getAttribute('transform'));
        const rect = g.querySelector('rect[data-part="label-box"]');
        const width = Number(rect?.getAttribute('width')) + 1;
        const height = Number(rect?.getAttribute('height')) + 1;
        const el = document.querySelector('.arch-edge-label[data-edge-id="' + id + '"]');
        const at = el ? E.toMap(el.getBoundingClientRect()) : null;
        return { id, picture: [x + width / 2, y + height / 2, width, height], canvas: at ? [at.x + at.width / 2, at.y + at.height / 2, at.width, at.height] : null };
      }),
    };
  },
  // The colours of the SVG beside the ones the browser computes on the canvas: per box its
  // background, its header and its name, per edge its line.
  colours: () => {
    const E = window.__smokeExport;
    const dashes = (text) => (text && text !== 'none' ? text.split(/[ ,]+/).filter(Boolean).map(parseFloat) : []);
    return {
      boxes: [...E.doc.querySelectorAll('g[data-node]')].map((g) => {
        const id = g.getAttribute('data-node');
        const node = document.querySelector('.react-flow__node[data-id="' + id + '"] .arch-node');
        const header = node?.querySelector('.arch-group-header');
        const name = node?.querySelector('.arch-node-name');
        const level = [...(node?.classList ?? [])].find((name) => name.startsWith('arch-level-'))?.slice(11);
        const shape = !node ? 'missing' : node.classList.contains('arch-leaf') ? 'leaf' : node.classList.contains('arch-collapsed') ? 'closed group' : 'open ' + level;
        return {
          id,
          kind: (node?.classList.contains('arch-tinted') ? 'tinted ' : '') + shape,
          box: [E.paint(g.querySelector('rect[data-part="box"]'), 'fill'), node ? E.rgba(getComputedStyle(node).backgroundColor) : null],
          header: header ? [E.paint(g.querySelector('[data-part="header"]'), 'fill'), E.rgba(getComputedStyle(header).backgroundColor)] : null,
          name: name ? [E.paint(g.querySelector('text'), 'fill'), E.rgba(getComputedStyle(name).color)] : null,
        };
      }),
      edges: [...E.doc.querySelectorAll('g[data-edge]')].map((g) => {
        const id = g.getAttribute('data-edge');
        const line = g.querySelector('[data-part="line"]');
        const path = document.querySelector('.react-flow__edge[data-id="' + id + '"] .react-flow__edge-path');
        const style = path ? getComputedStyle(path) : null;
        return {
          id,
          kind: g.getAttribute('data-kind'),
          stroke: [E.paint(line, 'stroke'), style ? E.rgba(style.stroke) : null],
          width: [Number(line?.getAttribute('stroke-width')), style ? parseFloat(style.strokeWidth) : null],
          dash: [dashes(line?.getAttribute('stroke-dasharray')), style ? dashes(style.strokeDasharray) : null],
        };
      }),
    };
  },
  // The name of every box that is no shrunk group (those wrap their name): what the canvas
  // holds and whether it cuts it, the room it has, and what the SVG writes — its length, and
  // the middle of its line (the baseline less 0.36 of the size) — beside the text as the canvas
  // lays it out (a range over it: for a cut name the uncut text).
  names: () => {
    const E = window.__smokeExport;
    return [...E.doc.querySelectorAll('g[data-node]')].flatMap((g) => {
      const id = g.getAttribute('data-node');
      const el = document.querySelector('.react-flow__node[data-id="' + id + '"] .arch-node-name');
      if (!el || el.closest('.arch-compact')) return [];
      const text = g.querySelector('text');
      const range = document.createRange();
      range.selectNodeContents(el);
      const drawn = E.toMap(range.getBoundingClientRect());
      const size = Number(text?.getAttribute('font-size'));
      return [{
        id,
        name: el.textContent,
        cut: el.scrollWidth > el.clientWidth,
        room: el.clientWidth,
        picture: text?.textContent ?? null,
        length: Number(text?.getAttribute('textLength')),
        middle: E.shift(g.getAttribute('transform'))[1] + Number(text?.getAttribute('y')) - 0.36 * size,
        range: { width: drawn.width, middle: drawn.y + drawn.height / 2 },
      }];
    });
  },
  // The list of every shrunk group: the text on the canvas and on how many lines it stands, and
  // the lines of the SVG.
  shrunk: () =>
    [...document.querySelectorAll('.arch-group.arch-compact')].map((box) => {
      const id = box.closest('.react-flow__node').dataset.id;
      const text = box.querySelector('.arch-collapsed-text');
      const range = document.createRange();
      range.selectNodeContents(text);
      const g = window.__smokeExport.doc.querySelector('g[data-node="' + id + '"]');
      return {
        id,
        canvas: text.textContent,
        canvasLines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size,
        lines: g ? [...g.children].filter((el) => el.localName === 'text' && el.getAttribute('text-anchor') === 'middle').map((el) => el.textContent) : null,
      };
    }),
  // Points of the map where a picture and the screen show a flat colour: 6 px inside the left
  // edge of every leaf at half its height, and of every group at half the height of its header;
  // 3 px inside the left end of every header; the middle of the lower quarter of every row
  // gutter. "clear" where that point is on the canvas with the thing itself on top (a row band
  // takes no pointer: the empty pane) and no edge label over it.
  probes: () => {
    const E = window.__smokeExport;
    const c = document.querySelector('.react-flow').getBoundingClientRect();
    const v = window.__smoke.viewport();
    const labels = [...document.querySelectorAll('.arch-edge-label:not(.arch-quiet)')].map((el) => el.getBoundingClientRect());
    const at = (x, y, owns) => {
      const sx = c.left + v.x + x * v.zoom;
      const sy = c.top + v.y + y * v.zoom;
      const top = sx >= c.left && sx < c.right && sy >= c.top && sy < c.bottom ? document.elementFromPoint(sx, sy) : null;
      const labelled = labels.some((r) => sx >= r.left - 2 && sx <= r.right + 2 && sy >= r.top - 2 && sy <= r.bottom + 2);
      return { x, y, screen: [sx - c.left, sy - c.top], clear: top !== null && owns(top) && !labelled };
    };
    const points = [];
    for (const el of document.querySelectorAll('.react-flow__node-leaf')) {
      const r = E.toMap(el.getBoundingClientRect());
      points.push({ id: el.dataset.id, kind: 'leaf', ...at(r.x + 6, r.y + r.height / 2, (top) => el.contains(top)) });
    }
    for (const el of document.querySelectorAll('.react-flow__node-group')) {
      const header = el.querySelector('.arch-group-header');
      const r = E.toMap(el.getBoundingClientRect());
      const h = E.toMap(header.getBoundingClientRect());
      const level = el.querySelector('.arch-level-domain') ? 'domain' : 'group';
      points.push({ id: el.dataset.id, kind: 'group', ...at(r.x + 6, h.y + h.height / 2, (top) => header.contains(top)) });
      points.push({ id: el.dataset.id, kind: level + ' header', ...at(h.x + 3, h.y + h.height / 2, (top) => header.contains(top)) });
    }
    for (const el of document.querySelectorAll('.react-flow__node-band .arch-band-gutter')) {
      const g = E.toMap(el.getBoundingClientRect());
      points.push({
        id: el.closest('.react-flow__node').dataset.id,
        kind: 'gutter',
        band: el.closest('.arch-band-odd') ? 'odd' : 'even',
        ...at(g.x + g.width / 2, g.y + g.height * 0.875, (top) => top.classList.contains('react-flow__pane')),
      });
    }
    return points;
  },
  // Puts a PNG back into the page, on a canvas kept under a name, and reads pixels of it.
  picture: async (name, base64) => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('the PNG is no image'));
      image.src = 'data:image/png;base64,' + base64;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    window.__smokeExport.pictures[name] = context;
    return { width: canvas.width, height: canvas.height };
  },
  pixels: (name, points) => points.map(([x, y]) => [...window.__smokeExport.pictures[name].getImageData(x, y, 1, 1).data]),
  // Lets go of the pixels of the pictures kept.
  forget: () => {
    for (const context of Object.values(window.__smokeExport.pictures)) context.canvas.width = context.canvas.height = 0;
    window.__smokeExport.pictures = {};
    return true;
  },
  // What lies on the canvas and is in no file — the dots of the background, the panels of the
  // canvas (minimap, zoom buttons, attribution) and the legends — hidden for a screenshot, and
  // shown again.
  hideOverlays: () => {
    const E = window.__smokeExport;
    E.hidden = [...document.querySelectorAll('.react-flow__background, .react-flow__panel, .map-legends')].map((el) => [el, el.style.visibility]);
    for (const [el] of E.hidden) el.style.visibility = 'hidden';
    return E.hidden.length;
  },
  showOverlays: () => {
    const E = window.__smokeExport;
    for (const [el, visibility] of E.hidden) el.style.visibility = visibility;
    E.hidden = [];
    return true;
  },
  // The canvas on screen: its rectangle, its size, how many pixels at its left the body of the
  // control panel lies over, and the pixels of the screen per pixel of the page.
  canvas: () => {
    const el = document.querySelector('.react-flow');
    const r = el.getBoundingClientRect();
    const panels = document.querySelector('.cp-panels');
    const column = document.querySelector('.app-column');
    const covered = panels && column && panels.getClientRects().length > 0 ? Math.max(0, panels.getBoundingClientRect().right - column.getBoundingClientRect().left) : 0;
    return { x: r.left, y: r.top, width: el.clientWidth, height: el.clientHeight, covered, ratio: window.devicePixelRatio };
  },
  // How much of the map — boxes, row bands, lines, labels, lists — is within "margin" pixels of
  // the canvas.
  inView: (margin) => {
    const c = document.querySelector('.react-flow').getBoundingClientRect();
    return [...document.querySelectorAll('.react-flow__node, .react-flow__edge-path, .arch-edge-label, .arch-workitems-above')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.left < c.right + margin && r.right > c.left - margin && r.top < c.bottom + margin && r.bottom > c.top - margin;
    }).length;
  },
  // The domain that reaches furthest to the right, and the one that reaches furthest down.
  outermost: () => {
    const domains = [...document.querySelectorAll('.react-flow__node-group')].filter((el) => !el.dataset.id.includes('.')).map((el) => ({ id: el.dataset.id, name: el.querySelector('.arch-node-name')?.textContent ?? '', r: el.getBoundingClientRect() }));
    const pick = (edge) => {
      const found = domains.reduce((best, domain) => (best === null || domain.r[edge] > best.r[edge] ? domain : best), null);
      return found ? { id: found.id, name: found.name } : null;
    };
    return { right: pick('left'), bottom: pick('bottom') };
  },
  // How far the box is from having left the canvas at its right edge, in pixels of the screen
  // (nothing left to go at 0 or below), with what a box may paint outside itself.
  toLeaveRight: (id) => {
    const c = document.querySelector('.react-flow').getBoundingClientRect();
    const r = document.querySelector('.react-flow__node[data-id="' + id + '"]').getBoundingClientRect();
    return c.right - r.left + 16 * window.__smoke.viewport().zoom;
  },
  // The heading and the key of the SVG, and what the canvas shows of the same: the chips of its
  // colour legend and the kinds of the edges it draws.
  key: () => {
    const E = window.__smokeExport;
    const attrs = (selector, name) => [...E.doc.querySelectorAll(selector)].map((el) => el.getAttribute(name));
    const legend = E.doc.querySelector('[data-part="legend"]');
    return {
      heading: [...E.doc.querySelectorAll('[data-part="heading"] text')].map((el) => el.textContent),
      headings: E.doc.querySelectorAll('[data-part="heading"]').length,
      legends: E.doc.querySelectorAll('[data-part="legend"]').length,
      // Where the key starts: the end of the map in the picture.
      legendTop: legend ? E.shift(legend.parentElement.getAttribute('transform'))[1] : null,
      keys: attrs('[data-key]', 'data-key'),
      kinds: attrs('[data-key-kind]', 'data-key-kind'),
      chips: [...E.doc.querySelectorAll('[data-key="colour"] [data-key-value]')].map((el) => ({ value: el.getAttribute('data-key-value'), colour: E.paint(el, 'fill') })),
      canvas: {
        chips: [...document.querySelectorAll('#color-legend [data-legend-value]')].map((li) => ({ value: li.dataset.legendValue, colour: E.rgba(getComputedStyle(li.querySelector('.color-legend-chip')).backgroundColor) })),
        kinds: ['dataflow', 'dependency', 'control', 'config'].filter((kind) => document.querySelector('.react-flow__edge.arch-edge-' + kind + ':not(.arch-quiet)') !== null),
      },
    };
  },
  // The opacity of every box, line and label in the SVG beside the one the browser computes on
  // the canvas, with whether the canvas dims or pales it; and the boxes the SVG rings.
  marks: () => {
    const E = window.__smokeExport;
    const pair = (g, el) => ({
      picture: Number(g.getAttribute('opacity') ?? 1),
      canvas: el ? Number(getComputedStyle(el).opacity) : null,
      dimmed: el?.classList.contains('arch-dimmed') ?? false,
      faded: el?.classList.contains('arch-faded') ?? false,
    });
    return {
      boxes: [...E.doc.querySelectorAll('g[data-node]')].map((g) => ({ id: g.getAttribute('data-node'), ...pair(g, document.querySelector('.react-flow__node[data-id="' + g.getAttribute('data-node') + '"]')) })),
      edges: [...E.doc.querySelectorAll('g[data-edge]')].map((g) => ({ id: g.getAttribute('data-edge'), ...pair(g, document.querySelector('.react-flow__edge[data-id="' + g.getAttribute('data-edge') + '"]')) })),
      labels: [...E.doc.querySelectorAll('g[data-edge-label]')].map((g) => ({ id: g.getAttribute('data-edge-label'), ...pair(g, document.querySelector('.arch-edge-label[data-edge-id="' + g.getAttribute('data-edge-label') + '"]')) })),
      ringed: [...E.doc.querySelectorAll('g[data-node]')].filter((g) => g.querySelector('[data-part="selected"]')).map((g) => g.getAttribute('data-node')),
      selected: [...document.querySelectorAll('.react-flow__node.selected')].map((el) => el.dataset.id),
    };
  },
  // The names of the domains with the larger titles: the sizes and the number of the lines the
  // SVG writes, and the size and the number of lines of the name on the canvas.
  largeTitles: () =>
    [...document.querySelectorAll('.arch-level-domain:not(.arch-compact)')].map((box) => {
      const id = box.closest('.react-flow__node').dataset.id;
      const name = box.querySelector('.arch-node-name');
      const style = getComputedStyle(name);
      const g = window.__smokeExport.doc.querySelector('g[data-node="' + id + '"]');
      const first = g?.querySelector('text');
      return {
        id,
        size: parseFloat(style.fontSize),
        lines: Math.round(name.offsetHeight / parseFloat(style.lineHeight)),
        picture: first ? [...g.children].filter((el) => el.localName === 'text' && el.getAttribute('font-size') === first.getAttribute('font-size') && el.getAttribute('text-anchor') === first.getAttribute('text-anchor')).map((el) => Number(el.getAttribute('font-size'))) : null,
      };
    }),
  // The work-item lines of the SVG and of the canvas, and those marked as selected.
  workItems: () => {
    const { doc } = window.__smokeExport;
    return {
      picture: doc.querySelectorAll('[data-workitem]').length,
      canvas: document.querySelectorAll('.arch-workitem').length,
      selected: {
        picture: [...doc.querySelectorAll('[data-workitem][data-selected="true"]')].map((g) => g.getAttribute('data-workitem')).sort(),
        canvas: [...document.querySelectorAll('.arch-workitem-selected')].map((el) => el.dataset.workitemId).sort(),
      },
    };
  },
  // The heat strips and the progress bars of the SVG beside those of the canvas, in pixels of
  // the map: the height and the count of a strip (its own rectangle: the one of a closed group
  // is not shortened by what clips it), the width of the done part of a bar.
  lenses: () => {
    const E = window.__smokeExport;
    const zoom = window.__smoke.viewport().zoom;
    return {
      strips: E.doc.querySelectorAll('[data-part="heat"]').length,
      heat: [...document.querySelectorAll('.arch-heat-left')].map((strip) => {
        const id = strip.closest('.react-flow__node').dataset.id;
        const g = E.doc.querySelector('g[data-node="' + id + '"] > g[data-part="heat"][data-side="left"]');
        return { id, canvas: [strip.getBoundingClientRect().height / zoom, strip.dataset.heat], picture: g ? [Number(g.querySelectorAll('rect')[1]?.getAttribute('height')), g.getAttribute('data-heat')] : null };
      }),
      bars: E.doc.querySelectorAll('[data-part="progress"]').length,
      progress: [...document.querySelectorAll('.arch-progress')].map((bar) => {
        const id = bar.closest('.react-flow__node').dataset.id;
        const g = E.doc.querySelector('g[data-node="' + id + '"] > g[data-part="progress"]');
        return { id, canvas: parseFloat(getComputedStyle(bar, '::after').width), picture: g ? Number(g.querySelectorAll('rect')[1]?.getAttribute('width') ?? 0) : null };
      }),
    };
  },
  // The handle at the right edge of a group that can be resized (none where groups cannot be):
  // its group and the point to grab it by.
  resizeHandle: () => {
    for (const el of document.querySelectorAll('.react-flow__node-group')) {
      const box = el.getBoundingClientRect();
      for (const handle of el.querySelectorAll('.arch-resize')) {
        const r = handle.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        if (Math.abs(x - box.right) <= 6 && y > box.top + box.height * 0.25 && y < box.bottom - box.height * 0.25 && handle.contains(document.elementFromPoint(x, y))) {
          return { id: el.dataset.id, x, y, zoom: window.__smoke.viewport().zoom };
        }
      }
    }
    return null;
  },
  // An exported page, read without being opened: what it must not hold, and what it lists.
  page: (text) => {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const all = [...doc.querySelectorAll('*')];
    const addresses = ['src', 'srcset', 'action', 'poster', 'data', 'background', 'xlink:href'];
    return {
      scripts: doc.scripts.length,
      handlers: all.flatMap((el) => el.getAttributeNames().filter((name) => name.toLowerCase().startsWith('on')).map((name) => el.localName + ' ' + name)),
      addresses: all.flatMap((el) => addresses.filter((name) => el.hasAttribute(name)).map((name) => el.localName + ' ' + name)),
      links: all.filter((el) => el.hasAttribute('href')).map((el) => el.getAttribute('href')),
      listed: [...doc.querySelectorAll('li[data-node]')].map((li) => li.getAttribute('data-node')),
      rows: doc.querySelectorAll('tr[data-edge]').length,
      drawn: [...doc.querySelectorAll('.map svg g[data-node]')].map((g) => g.getAttribute('data-node')),
      names: [...doc.querySelectorAll('.map svg g[data-node]')].map((g) => g.querySelector('text')?.textContent ?? ''),
    };
  },
})`;
const PROFILE_PREFIX = 'arch-map-smoke-';
/** The profile directory that every run uses, unless another run is using it at that moment. */
const SHARED_PROFILE = `${PROFILE_PREFIX}profile`;
/** A profile directory older than this belongs to no run that is still going. */
const STALE_PROFILE_MS = 30 * 60 * 1000;

/**
 * Removes a browser profile. The browser may hold on to its files for a moment after it has
 * exited, hence the retries.
 * @param {string} dir
 * @param {number} [retries]
 * @returns {Promise<boolean>} whether the directory is gone
 */
async function removeProfile(dir, retries = 6) {
  await rm(dir, { recursive: true, force: true, maxRetries: retries, retryDelay: 200 }).catch(
    () => undefined,
  );
  return !existsSync(dir);
}

/** @param {number} pid @returns {boolean} whether a process with that ID exists */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/**
 * The profile directory for this run. It is the same directory for every run, emptied as far as
 * the system allows: a profile cannot always be removed once the browser has used it (security
 * software may keep every other program out of a browser's profile, even after the browser has
 * exited), and a fresh directory per run then leaves one behind each time. What cannot be
 * removed is used again — the run clears the page's storage itself. A lock file with the
 * process ID keeps two runs at the same time apart: the second one gets a directory of its own.
 * @returns {Promise<{ dir: string, lock: string | undefined }>}
 */
async function prepareProfile() {
  const temp = os.tmpdir();
  const dir = path.join(temp, SHARED_PROFILE);
  const lock = `${dir}.lock`;
  const own = async () => ({
    dir: await mkdtemp(path.join(temp, PROFILE_PREFIX)),
    lock: undefined,
  });
  const owner = Number(await readFile(lock, 'utf8').catch(() => ''));
  if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && isRunning(owner)) {
    return own();
  }
  await rm(lock, { force: true }).catch(() => undefined);
  try {
    await writeFile(lock, String(process.pid), { flag: 'wx' });
  } catch {
    return own();
  }
  await removeProfile(dir, 0);
  // The port file of an earlier browser would be taken for the one of this run.
  if (existsSync(path.join(dir, 'DevToolsActivePort'))) {
    await rm(lock, { force: true }).catch(() => undefined);
    return own();
  }
  await mkdir(dir, { recursive: true });
  return { dir, lock };
}

/**
 * Removes the profile directories of their own that earlier runs could not remove (best effort,
 * silent): a directory that cannot be removed now is tried again by the next run.
 */
async function removeStaleProfiles() {
  const temp = os.tmpdir();
  const names = await readdir(temp).catch(() => []);
  const now = Date.now();
  await Promise.all(
    names
      .filter((name) => name.startsWith(PROFILE_PREFIX) && name !== SHARED_PROFILE)
      .map(async (name) => {
        const dir = path.join(temp, name);
        const info = await stat(dir).catch(() => undefined);
        if (!info?.isDirectory() || now - info.mtimeMs < STALE_PROFILE_MS) return;
        // No retries: with many directories that resist, they would keep the script busy for
        // minutes, long after this function has returned.
        await removeProfile(dir, 0);
      }),
  );
}

/**
 * @param {string} viewerPath
 * @param {string} browserPath
 * @returns {Promise<string[]>} the failed checks
 */
async function run(viewerPath, browserPath) {
  await removeStaleProfiles();
  const { dir: profile, lock: profileLock } = await prepareProfile();
  const browser = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      ...OFFLINE_FLAGS,
      '--allow-file-access-from-files',
      // Wide enough for the body of the control panel to stand beside the canvas.
      '--window-size=1836,827',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  /** @type {Cdp | undefined} */
  let cdp;
  /** Directory for the data files the run writes itself; removed at the end. @type {string | undefined} */
  let scratch;
  /** Address of the exported page the run opens itself. @type {string | undefined} */
  let exportedPage;
  /** @type {string[]} */
  const failures = [];
  /** @param {string} name @param {unknown} ok @param {unknown} [detail] */
  const check = (name, ok, detail) => {
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    );
    if (!ok) failures.push(name);
  };

  try {
    // The browser writes the port it chose, then the page target appears.
    const portFile = path.join(profile, 'DevToolsActivePort');
    const port = await waitFor(async () => {
      if (!existsSync(portFile)) return undefined;
      const [first] = (await readFile(portFile, 'utf8')).split('\n');
      return first ? Number(first) : undefined;
    }, 'the browser to start');
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => undefined);
      if (!response?.ok) return undefined;
      const targets = /** @type {{ type: string, webSocketDebuggerUrl: string }[]} */ (
        await response.json()
      );
      return targets.find((entry) => entry.type === 'page');
    }, 'a page target');
    const client = await connect(target.webSocketDebuggerUrl);
    cdp = client;
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    // Offline: every request of the page and every violation of its Content
    // Security Policy is recorded during the whole run, for the checks at its end.
    /** @type {string[]} */
    const requests = [];
    client.on('Network.requestWillBeSent', (params) => requests.push(params.request.url));
    await client.send('Network.enable');
    /** @type {string[]} */
    const violations = [];
    client.on('Runtime.consoleAPICalled', (params) => {
      const text = params.args?.[0]?.value;
      if (typeof text === 'string' && text.startsWith(VIOLATION_MARK)) {
        violations.push(text.slice(VIOLATION_MARK.length));
      }
    });
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `document.addEventListener('securitypolicyviolation', (event) => console.warn(${JSON.stringify(VIOLATION_MARK)} + event.effectiveDirective + ' ' + (event.blockedURI || event.sample)));`,
    });

    /** @param {string} expression @returns {Promise<any>} */
    const evaluate = async (expression) => {
      const result = await client.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(`page error in ${expression}: ${result.exceptionDetails.text}`);
      }
      return result.result.value;
    };
    /** @param {string} expression @param {string} what */
    const until = async (expression, what) => {
      try {
        return await waitFor(() => evaluate(expression), what);
      } catch (error) {
        // What the page was doing when the wait gave up: the state of the app's root element.
        const state = await evaluate(
          `(() => { const app = document.querySelector('.app'); return app ? JSON.stringify({ ...app.dataset, active: document.activeElement?.id, error: document.querySelector('#viewer-error')?.textContent }) : 'no app'; })()`,
        ).catch(() => 'unknown');
        throw new Error(`${error instanceof Error ? error.message : String(error)} (${state})`, {
          cause: error,
        });
      }
    };
    /** Whether the expression comes to hold in the page: false when it does not in time. */
    const eventually = (/** @type {string} */ expression, /** @type {string} */ what) =>
      until(expression, what).then(
        () => true,
        () => false,
      );
    /** @param {{ x: number, y: number } | null} point @param {string} what */
    const clickAt = async (point, what) => {
      if (!point) throw new Error(`nothing to click for ${what}`);
      const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
      await client.send('Input.dispatchMouseEvent', {
        ...base,
        type: 'mouseMoved',
        button: 'none',
      });
      await client.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
      await client.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
    };
    /**
     * Presses the left button at `from`, moves to `to` in steps and (unless `hold`) releases.
     * @param {{ x: number, y: number }} from @param {{ x: number, y: number }} to
     * @param {{ hold?: boolean }} [options]
     */
    const drag = async (from, to, options = {}) => {
      const at = (/** @type {{ x: number, y: number }} */ p) => ({
        x: p.x,
        y: p.y,
        button: 'left',
      });
      await client.send('Input.dispatchMouseEvent', {
        ...at(from),
        type: 'mouseMoved',
        button: 'none',
      });
      await client.send('Input.dispatchMouseEvent', {
        ...at(from),
        type: 'mousePressed',
        buttons: 1,
        clickCount: 1,
      });
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const point = {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        };
        await client.send('Input.dispatchMouseEvent', {
          ...at(point),
          type: 'mouseMoved',
          buttons: 1,
        });
      }
      if (!options.hold) {
        await client.send('Input.dispatchMouseEvent', {
          ...at(to),
          type: 'mouseReleased',
          clickCount: 1,
        });
      }
    };
    /** Waits until the view has stopped moving (animated pan/zoom), so that points stay put. */
    const settled = async () => {
      let last = '';
      await waitFor(async () => {
        const now = JSON.stringify(await evaluate('window.__smoke.viewport()'));
        const still = now === last;
        last = now;
        if (!still) await sleep(120);
        return still;
      }, 'the view to come to rest');
    };
    /**
     * Shows the tab of the control panel that holds the element, with a click on the rail.
     * Nothing to do for an element on the tab shown, or in no tab.
     * @param {string} selector
     */
    const showControl = async (selector) => {
      /** @type {string | null} */
      const tab = await evaluate(`window.__smoke.tabFor(${JSON.stringify(selector)})`);
      if (tab === null) return;
      const point = await until(`window.__smoke.clickPoint('#${tab}')`, `a clickable #${tab}`);
      await clickAt(point, `#${tab}`);
      await until(
        `window.__smoke.attr('data-panel-tab') === '${tab.replace('tab-', '')}' && window.__smoke.attr('data-panel-collapsed') === 'false'`,
        `the tab of ${selector}`,
      );
    };
    /** @param {string} selector */
    const click = async (selector) => {
      await settled();
      await until(`window.__smoke.count(${JSON.stringify(selector)}) > 0`, selector);
      await showControl(selector);
      const point = await until(
        `window.__smoke.clickPoint(${JSON.stringify(selector)})`,
        `a clickable ${selector}`,
      );
      await clickAt(point, selector);
    };
    /**
     * Rests the pointer on the empty part of the rail of the control panel: on nothing of the
     * map, and clear of the search results, which open to the right of the rail.
     */
    const park = async () => {
      const point = await evaluate(`(() => {
        const r = document.querySelector('.cp-rail-spacer').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    };
    /** @param {string} key @param {{ code?: string, keyCode?: number, text?: string, modifiers?: number }} [extra] */
    const press = async (key, extra = {}) => {
      const event = { key, code: extra.code ?? key, windowsVirtualKeyCode: extra.keyCode ?? 0 };
      await client.send('Input.dispatchKeyEvent', {
        ...event,
        type: extra.text === undefined ? 'rawKeyDown' : 'keyDown',
        ...(extra.text === undefined ? {} : { text: extra.text }),
        modifiers: extra.modifiers ?? 0,
      });
      await client.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
    };
    /**
     * Puts the cursor in the search box with its shortcut: "/", or Ctrl+K. The pointer is parked
     * first: where a click on a control left it, the results would open under it, and a result
     * under the pointer takes the highlight.
     * @param {'/' | 'k'} [key]
     */
    const openSearch = async (key = '/') => {
      await park();
      if (key === 'k') await press('k', { code: 'KeyK', keyCode: 75, modifiers: 2 });
      else await press('/', { code: 'Slash', keyCode: 191, text: '/' });
    };
    /** Left and right edge and the width of an element on screen. @param {string} selector */
    const sides = (selector) =>
      evaluate(`(() => {
        const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      })()`);
    /** Collapses the body of the control panel to the rail, or shows it again. @param {boolean} collapsed */
    const togglePanel = async (collapsed) => {
      await click('#panel-toggle');
      await until(
        `window.__smoke.attr('data-panel-collapsed') === '${collapsed}'`,
        `the control panel ${collapsed ? 'collapsed' : 'open'}`,
      );
    };
    /**
     * Whether two viewports are the same view: within a pixel and a thousandth of the zoom.
     * @param {{ x: number, y: number, zoom: number }} a @param {{ x: number, y: number, zoom: number }} b
     */
    const sameView = (a, b) =>
      Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.zoom - b.zoom) < 0.001;
    const selection = () => evaluate(`window.__smoke.attr('data-selection')`);
    /** @param {string | null} value */
    const untilSelection = (value) =>
      until(
        `window.__smoke.attr('data-selection') === ${JSON.stringify(value)}`,
        `selection ${value}`,
      );
    /**
     * Clicks on the line of every rendered edge and returns the edges that could not be selected
     * that way. Several points are tried (a quarter along, three quarters, the middle, then the
     * rest): where two lanes cross or touch, a click cannot tell them apart, but somewhere along
     * its own line every edge must be selectable.
     * @returns {Promise<{ tried: number, wrong: string[] }>}
     */
    const clickEveryEdge = async () => {
      await settled();
      /** @type {string[]} */
      const ids = await evaluate(`window.__smoke.edgeIds()`);
      /** @type {string[]} */
      const wrong = [];
      for (const id of ids) {
        await press('Escape', { keyCode: 27 });
        await untilSelection(null);
        /** @type {{ x: number, y: number }[]} */
        const points = await evaluate(`window.__smoke.edgePoints(${JSON.stringify(id)})`);
        const at = (/** @type {number} */ fraction) => Math.floor(points.length * fraction);
        const order = [...new Set([at(0.25), at(0.75), at(0.5), ...points.keys()])];
        let selectedLine = 'no reachable point';
        for (const index of order) {
          const point = points[index];
          if (!point) continue;
          await press('Escape', { keyCode: 27 });
          await untilSelection(null);
          await clickAt(point, id);
          await until(`window.__smoke.attr('data-selection') !== null`, `a selection for ${id}`);
          selectedLine = await evaluate(
            `document.querySelector('.react-flow__edge.selected')?.dataset.id ?? null`,
          );
          if (selectedLine === id) break;
        }
        if (selectedLine !== id) wrong.push(`${id} (selected ${selectedLine})`);
      }
      await press('Escape', { keyCode: 27 });
      await untilSelection(null);
      return { tried: ids.length, wrong };
    };
    // The data files of the run: the example and the dummy work items next to the viewer.
    const dataFiles = ['architecture.yaml', 'workitems.json'].map((name) =>
      path.join(path.dirname(viewerPath), name),
    );
    /**
     * Drops files on the page, as from the file manager. The pointer is parked afterwards, so
     * that it rests on nothing of the map.
     * @param {string[]} files
     */
    const dropFiles = async (files) => {
      const data = { items: [], files, dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await client.send('Input.dispatchDragEvent', { type, x: 700, y: 500, data });
      }
      await park();
    };
    /** Waits for the page without a map: opened from disk it has to be given its files. */
    const startPage = () =>
      until(
        `document.readyState === 'complete' && document.querySelector('.app')?.getAttribute('data-load') === 'empty'`,
        'the start page',
      );
    const mapShown = async () => {
      await until(
        `document.readyState === 'complete' && document.querySelectorAll('.react-flow__node').length > 0`,
        'the map to render',
      );
      await evaluate(PAGE_HELPERS);
      // The fit (or the restored viewport) has been applied once a level of detail is shown.
      await until(
        `window.__smoke.attr('data-lod') !== null && window.__smoke.viewport() !== null`,
        'a viewport',
      );
      await sleep(300);
    };
    const open = async () => {
      await client.send('Page.navigate', { url: pathToFileURL(viewerPath).href });
      await startPage();
      await dropFiles(dataFiles);
      await mapShown();
    };
    /**
     * Reloads the page with the given fragment in its address and gives it its files again. (A
     * navigation that only changes the fragment is no reload: the page is reloaded explicitly.)
     * @param {string} hash
     */
    const reloadWith = async (hash) => {
      await evaluate(
        `window.history.replaceState(null, '', window.location.href.split('#')[0] + ${JSON.stringify(hash)})`,
      );
      await client.send('Page.reload');
      await startPage();
      await dropFiles(dataFiles);
      await until(
        `document.readyState === 'complete' && document.querySelectorAll('.react-flow__node').length > 0`,
        'the map after the reload',
      );
      await evaluate(PAGE_HELPERS);
      await until(`window.__smoke.attr('data-lines-laid-out') === 'true'`, 'the reloaded layout');
      await sleep(300);
    };

    // --- Load ---------------------------------------------------------------------------------
    // The profile may be one that an earlier run left behind (see `prepareProfile`): the first
    // load starts without anything such a run stored.
    const cleared = await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source:
        "try { localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('architecture-map'); } catch {}",
    });
    await client.send('Page.navigate', { url: pathToFileURL(viewerPath).href });
    await startPage();
    await client.send('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: cleared.identifier,
    });
    const startState = () =>
      evaluate(`({
        status: document.querySelector('#load-status')?.textContent ?? null,
        openButton: document.querySelectorAll('#empty-state button.primary').length,
        recent: [...document.querySelectorAll('#recent-start li')].map((li) => li.dataset.recent),
        nodes: document.querySelectorAll('.react-flow__node').length,
      })`);
    const firstStart = await startState();
    check(
      'opened from file:// the page says that it has to be given its file, and loads nothing',
      firstStart.status.includes('cannot read architecture.yaml by itself') &&
        firstStart.openButton === 1 &&
        firstStart.recent.length === 0 &&
        firstStart.nodes === 0,
      firstStart,
    );
    // Where the template is, as the page without a map says it: on the empty page, and on the
    // Files tab, which the control panel shows then.
    const templateAtStart = await evaluate(`({
      hint: document.querySelector('#empty-state #template-hint')?.textContent ?? null,
      hintShown: (document.querySelector('#template-hint')?.getClientRects().length ?? 0) > 0,
      note: document.querySelector('#template-note')?.textContent ?? null,
      noteShown: (document.querySelector('#template-note')?.getClientRects().length ?? 0) > 0,
      viewNotes: document.querySelectorAll('#view-note').length,
    })`);
    await dropFiles(dataFiles);
    await mapShown();
    check(
      'renders from file:// from the data files dropped on the page',
      (await evaluate(`window.__smoke.attr('data-load')`)) === 'ready' &&
        (await evaluate(`document.querySelector('#source-name')?.dataset.origin`)) === 'file' &&
        (await evaluate(`window.__smoke.text('#source-name')`)) === 'architecture.yaml',
    );
    // The version (README.md, "Versioning"): the one of package.json, at the head of the
    // control panel and in the page itself.
    const packageVersion = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ).version;
    const shownVersion = await evaluate(`({
      head: document.querySelector('#app-version')?.textContent ?? null,
      root: document.querySelector('.app')?.dataset.version ?? null,
      page: document.querySelector('meta[name="generator"]')?.content ?? null,
    })`);
    check(
      `the viewer shows its version, ${packageVersion}, and the page names it`,
      /^\d+\.\d+\.\d+/.test(packageVersion) &&
        shownVersion.head === packageVersion &&
        shownVersion.root === packageVersion &&
        shownVersion.page === `architecture-map ${packageVersion}`,
      shownVersion,
    );
    const recentState = () =>
      evaluate(`({
        entries: [...document.querySelectorAll('#recent-list li')].map((li) => ({
          label: li.dataset.recent,
          current: li.dataset.current === 'true',
          hint: li.querySelector('.recent-hint')?.textContent ?? '',
        })),
        reload: document.querySelectorAll('#reload-files').length,
      })`);
    const firstRecent = await recentState();
    check(
      'the map opened from disk is remembered: its two files, with a hint of what is in it',
      firstRecent.entries.length === 1 &&
        firstRecent.entries[0].label === 'architecture.yaml + workitems.json' &&
        firstRecent.entries[0].current &&
        firstRecent.entries[0].hint.length > 5 &&
        firstRecent.reload === 1,
      firstRecent,
    );
    check(
      'nothing selected, no panel at start',
      (await selection()) === null &&
        (await evaluate(`window.__smoke.count('#detail-panel')`)) === 0,
    );

    // --- Control panel: tabs, every control, the edge legend, collapsing, a reload ------------
    const tabNames = ['detail', 'visibility', 'lenses', 'layout', 'views', 'files'];
    const tabsState = () => evaluate(`window.__smoke.tabs()`);
    /** @param {unknown} a @param {unknown} b */
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    /** Whether the open panel shows that tab and no other. @param {string} name */
    const showsTab = async (name) => {
      const state = await tabsState();
      return (
        same(state.selected, [`tab-${name}`]) &&
        same(state.shown, [`panel-${name}`]) &&
        state.tab === name &&
        state.collapsed === 'false'
      );
    };
    const tabsAtStart = await tabsState();
    check(
      'the control panel has six tabs, each with its panel, and shows the first: Level of detail',
      same(
        tabsAtStart.tabs,
        tabNames.map((name) => `tab-${name}`),
      ) &&
        tabsAtStart.disabled.length === 0 &&
        tabsAtStart.paired &&
        tabsAtStart.panels === 6 &&
        (await showsTab('detail')),
      tabsAtStart,
    );
    // Until a tab or Hide is clicked the body follows the window: open where it stands beside
    // the canvas, collapsed where it would lie over it. That is no choice, and nothing is stored.
    const panelStored = () => evaluate(`localStorage.getItem('architecture-map.control-panel')`);
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1200,
      height: 827,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await until(
      `window.__smoke.attr('data-panel-collapsed') === 'true'`,
      'the body collapsed in a narrow window',
    );
    const storedNarrow = await panelStored();
    await client.send('Emulation.clearDeviceMetricsOverride');
    await until(
      `window.__smoke.attr('data-panel-collapsed') === 'false'`,
      'the body open again in the wide window',
    );
    check(
      'until the reader chooses, the body of the control panel is open in a wide window and collapsed in a narrow one',
      storedNarrow === null && (await panelStored()) === null && (await showsTab('detail')),
      { storedNarrow, stored: await panelStored() },
    );
    await click('#tab-visibility');
    await until(`window.__smoke.attr('data-panel-tab') === 'visibility'`, 'the Visibility tab');
    check(
      'a click on another tab shows its panel and hides the others',
      await showsTab('visibility'),
      await tabsState(),
    );
    // The arrow keys go from tab to tab and around the ends, Home and End to the first and the
    // last; the focus goes along.
    /** @type {string[]} */
    const wrongKeys = [];
    for (const [key, keyCode, name] of /** @type {[string, number, string][]} */ ([
      ['ArrowDown', 40, 'lenses'],
      ['ArrowUp', 38, 'visibility'],
      ['End', 35, 'files'],
      ['ArrowDown', 40, 'detail'],
      ['ArrowUp', 38, 'files'],
      ['Home', 36, 'detail'],
    ])) {
      await press(key, { keyCode });
      await until(
        `window.__smoke.attr('data-panel-tab') === '${name}'`,
        `the ${name} tab after ${key}`,
      );
      if (!(await showsTab(name)) || (await tabsState()).active !== `tab-${name}`) {
        wrongKeys.push(`${key}: ${name}`);
      }
    }
    check(
      'ArrowDown, ArrowUp, Home and End move the selection among the tabs',
      wrongKeys.length === 0,
      wrongKeys,
    );
    // The panels of the tabs that are not shown stay in the page: every control is there, once,
    // whichever tab is shown. (The note of collapsed groups, the list of saved views with its
    // note and the search results come and go.)
    const controlIds = [
      'app-version',
      'source-name',
      'workitems-source',
      'search-open',
      'search',
      'search-input',
      'reload-files',
      'fit-view',
      'panel-toggle',
      'lod-indicator',
      'collapse-all',
      'expand-all',
      'compact-collapsed',
      'story-mode',
      'zoom-readout',
      'reset-thresholds',
      'focus-control',
      'focus-select',
      'focus-mode',
      'focus-mode-hint',
      'kind-filters',
      'edges-on-demand',
      'workitem-filter',
      'workitem-filter-count',
      'show-completed',
      'workitem-iteration',
      'lenses',
      'color-by',
      'heat',
      'progress',
      'show-rows',
      'unlock-positions',
      'reset-positions',
      'views',
      'view-name',
      'save-view',
      'copy-view-link',
      'model-summary',
      'open-yaml',
      'workitems-summary',
      'open-workitems',
      'recent',
      'recent-list',
      'yaml-file',
      'workitems-file',
    ];
    /** @type {Record<string, number>} */
    const idCounts = await evaluate(
      `Object.fromEntries(${JSON.stringify(controlIds)}.map((id) => [id, document.querySelectorAll('[id="' + id + '"]').length]))`,
    );
    const notOnce = controlIds
      .filter((id) => idCounts[id] !== 1)
      .map((id) => `${id}: ${idCounts[id]}`);
    const choices = await evaluate(`({
      kinds: window.__smoke.count('#kind-filters button[data-kind]'),
      levels: window.__smoke.count('#lod-indicator button[data-lod-option]'),
      stories: window.__smoke.count('#story-mode button[data-story-option]'),
      thresholds: window.__smoke.count('input[data-threshold]'),
    })`);
    check(
      'every control is in the page exactly once, whichever tab is shown',
      notOnce.length === 0 &&
        choices.kinds === 4 &&
        choices.levels === 5 &&
        choices.stories === 3 &&
        choices.thresholds === 3,
      { notOnce, choices },
    );
    // A tab is named by its caption alone; what its mark stands for is said in its tooltip, and
    // the names in the head of the panel, which are cut where they are long, in theirs.
    const tabTexts = await evaluate(`({
      marks: [...document.querySelectorAll('.cp-tab .cp-tab-mark')].map((mark) => mark.getAttribute('aria-hidden')),
      detail: document.querySelector('#tab-detail').title,
      level: window.__smoke.attr('data-lod'),
      structure: document.querySelector('#source-name').title,
      workItems: document.querySelector('#workitems-source').title,
    })`);
    const levelNames = /** @type {Record<string, string>} */ ({
      domains: 'Domains',
      components: 'Components',
      subcomponents: 'Subcomponents',
      detail: 'Everything',
    });
    check(
      'the tooltip of the Detail tab names the level its mark abbreviates, and the file names have tooltips',
      tabTexts.marks.length > 0 &&
        tabTexts.marks.every((/** @type {string | null} */ hidden) => hidden === 'true') &&
        tabTexts.detail.startsWith(`Level of detail: ${levelNames[tabTexts.level]} — `) &&
        tabTexts.structure.endsWith('architecture.yaml') &&
        tabTexts.workItems.endsWith('workitems.json'),
      tabTexts,
    );
    // The key to the edge kinds lies on the canvas, whatever the panel shows, and says which
    // kinds are hidden.
    const edgeLegend = () =>
      evaluate(`(() => {
        const legend = document.querySelector('#edge-legend');
        const canvas = document.querySelector('#map-canvas').getBoundingClientRect();
        const r = legend.getBoundingClientRect();
        return {
          kinds: [...legend.querySelectorAll('li')].map((li) => li.dataset.kind),
          hidden: [...legend.querySelectorAll('li[data-hidden="true"]')].map((li) => li.dataset.kind),
          onCanvas: r.width > 0 && r.left >= canvas.left && r.right <= canvas.right && r.top >= canvas.top && r.bottom <= canvas.bottom,
        };
      })()`);
    const legendAtStart = await edgeLegend();
    check(
      'the edge legend on the canvas lists the four kinds',
      same(legendAtStart.kinds, ['dataflow', 'dependency', 'control', 'config']) &&
        legendAtStart.hidden.length === 0 &&
        legendAtStart.onCanvas,
      legendAtStart,
    );
    await click('#kind-filters [data-kind="control"]');
    await until(`window.__smoke.attr('data-hidden-kinds') === 'control'`, 'a hidden kind');
    const legendHidden = await edgeLegend();
    await click('#kind-filters [data-kind="control"]');
    await until(`window.__smoke.attr('data-hidden-kinds') === ''`, 'the kind shown again');
    check(
      'hiding a kind marks its entry in the edge legend',
      same(legendHidden.hidden, ['control']) && (await edgeLegend()).hidden.length === 0,
      legendHidden,
    );
    // Hide: the body goes and the rail stays; the canvas takes the room, and the view is left
    // as it is.
    const canvasOpen = await sides('#map-canvas');
    const bodyOpen = await sides('#control-panel-body');
    const viewOpen = await evaluate(`window.__smoke.viewport()`);
    await togglePanel(true);
    await settled();
    const canvasCollapsed = await sides('#map-canvas');
    const viewCollapsed = await evaluate(`window.__smoke.viewport()`);
    check(
      'Hide collapses the control panel to its rail: the canvas grows by the width of the body and the view stays',
      bodyOpen.width > 0 &&
        Math.abs(canvasCollapsed.width - canvasOpen.width - bodyOpen.width) < 1 &&
        same(viewCollapsed, viewOpen) &&
        (await evaluate(`document.querySelector('#control-panel-body').hidden`)) === true &&
        (await evaluate(
          `document.querySelector('#panel-toggle').getAttribute('aria-expanded')`,
        )) === 'false',
      { canvasOpen, bodyOpen, canvasCollapsed, viewOpen, viewCollapsed },
    );
    await click('#fit-view');
    await until(
      `JSON.stringify(window.__smoke.viewport()) !== ${JSON.stringify(JSON.stringify(viewOpen))}`,
      'the view fitted to the wider canvas',
    );
    await settled();
    check(
      'with the panel collapsed Fit view fits the map into the wider canvas',
      (await evaluate(`window.__smoke.offCanvas()`)).length === 0,
      {
        view: await evaluate(`window.__smoke.viewport()`),
        off: await evaluate(`window.__smoke.offCanvas()`),
      },
    );
    // Collapsed, "/" still reaches the search box: it shows beside the rail for as long as it
    // is in use, and the canvas keeps its width.
    const beforeSearch = await evaluate(`document.activeElement?.id ?? null`);
    await openSearch();
    check(
      '"/" with the panel collapsed puts the cursor in the search box at once',
      (await evaluate(`document.activeElement?.id ?? null`)) === 'search-input',
    );
    await client.send('Input.insertText', { text: 'iphone' });
    await until(`window.__smoke.count('#search-results [role="option"]') > 0`, 'search results');
    const flyout = await evaluate(`(() => {
      const shown = (selector) => document.querySelector(selector).getClientRects().length > 0;
      const rail = document.querySelector('.cp-rail').getBoundingClientRect();
      const results = document.querySelector('#search-results').getBoundingClientRect();
      return {
        typed: document.querySelector('#search-input').value,
        lists: window.__smoke.count('#search-results'),
        body: shown('#control-panel-body'),
        head: shown('.cp-head'),
        panels: shown('.cp-panels'),
        collapsed: window.__smoke.attr('data-panel-collapsed'),
        canvas: document.querySelector('#map-canvas').getBoundingClientRect().width,
        beside: results.left >= rail.right && results.right <= document.documentElement.clientWidth,
      };
    })()`);
    check(
      'the search box shows beside the rail while it is in use: the panel stays collapsed, the canvas keeps its width',
      flyout.typed === 'iphone' &&
        flyout.lists === 1 &&
        flyout.body &&
        !flyout.head &&
        !flyout.panels &&
        flyout.beside &&
        flyout.collapsed === 'true' &&
        Math.abs(flyout.canvas - canvasCollapsed.width) < 1,
      flyout,
    );
    await press('Escape', { code: 'Escape', keyCode: 27 });
    await press('Escape', { code: 'Escape', keyCode: 27 });
    await until(`document.querySelector('#control-panel-body').hidden`, 'the search box gone');
    check(
      'Escape twice leaves the search, and the box beside the rail is gone',
      (await evaluate(`document.querySelector('#search-input').value`)) === '' &&
        (await evaluate(`document.activeElement?.id ?? null`)) !== 'search-input' &&
        (await evaluate(`window.__smoke.attr('data-panel-collapsed')`)) === 'true',
    );
    // The box is gone, so the cursor goes back to where it was before the search (Fit view, on
    // the rail), and the Tab key goes on from there. From nowhere it goes to the Search button.
    const afterEscape = await evaluate(`document.activeElement?.id ?? null`);
    await press('Tab', { code: 'Tab', keyCode: 9 });
    const afterEscapeTab = await evaluate(`document.activeElement?.id ?? null`);
    await evaluate(`document.activeElement?.blur()`);
    await openSearch();
    await press('Escape', { code: 'Escape', keyCode: 27 });
    await until(`document.querySelector('#control-panel-body').hidden`, 'the search box gone');
    const afterEscapeFromNowhere = await evaluate(`document.activeElement?.id ?? null`);
    check(
      'leaving the search beside the rail with Escape gives the cursor back to where it was, or to the Search button, and Tab goes on from there',
      beforeSearch === 'fit-view' &&
        afterEscape === 'fit-view' &&
        afterEscapeTab === 'panel-toggle' &&
        afterEscapeFromNowhere === 'search-open',
      { beforeSearch, afterEscape, afterEscapeTab, afterEscapeFromNowhere },
    );
    // Tab in the box leaves the search as well: the list of matches, which scrolls when it is
    // long, is no stop on the way, and the box beside the rail goes.
    await openSearch();
    await client.send('Input.insertText', { text: 's' });
    await until(`window.__smoke.count('#search-results [role="option"]') > 0`, 'search results');
    const longList = await evaluate(`(() => {
      const list = document.querySelector('#search-results');
      return { scrolls: list.scrollHeight > list.clientHeight, tabIndex: list.tabIndex };
    })()`);
    await press('Tab', { code: 'Tab', keyCode: 9 });
    await sleep(200);
    const afterTab = await evaluate(`({
      card: !document.querySelector('#control-panel-body').hidden,
      active: document.activeElement?.id || document.activeElement?.tagName,
    })`);
    check(
      'Tab in the search box beside the rail leaves the search although the list of matches scrolls: the box goes',
      longList.scrolls &&
        !afterTab.card &&
        afterTab.active !== 'search-results' &&
        afterTab.active !== 'BODY',
      { longList, afterTab },
    );
    // The query is still in the box: cleared, for the checks below.
    await openSearch();
    await press('Escape', { code: 'Escape', keyCode: 27 });
    await press('Escape', { code: 'Escape', keyCode: 27 });
    await until(`document.querySelector('#control-panel-body').hidden`, 'the search box gone');
    await evaluate(`document.activeElement?.blur()`);
    // Collapsed, the head of the panel is not on screen: the page keeps its one heading.
    const headings = () =>
      evaluate(
        `[...document.querySelectorAll('h1')].filter((h) => h.getClientRects().length > 0).map((h) => h.textContent)`,
      );
    const headingsCollapsed = await headings();
    await click('#tab-layout');
    await until(
      `window.__smoke.attr('data-panel-collapsed') === 'false'`,
      'the body opened by a tab',
    );
    check(
      'a click on a tab while the panel is collapsed opens it on that tab',
      (await showsTab('layout')) &&
        Math.abs((await sides('#map-canvas')).width - canvasOpen.width) < 1,
      await tabsState(),
    );
    const headingsOpen = await headings();
    check(
      'the page has one level-one heading, with the panel collapsed and with it open',
      same(headingsCollapsed, ['Architecture Map']) && same(headingsOpen, ['Architecture Map']),
      { headingsCollapsed, headingsOpen },
    );
    await click('#fit-view');
    await settled();
    check(
      'with the panel open again Fit view comes back to the view of before',
      sameView(await evaluate(`window.__smoke.viewport()`), viewOpen),
      { viewOpen, now: await evaluate(`window.__smoke.viewport()`) },
    );
    // A reload keeps the tab and whether the body is collapsed. Without a structure only Files
    // can be chosen, and the tab kept for the map is not replaced by it.
    await togglePanel(true);
    await client.send('Page.navigate', { url: pathToFileURL(viewerPath).href });
    await startPage();
    await evaluate(PAGE_HELPERS);
    const tabsReloaded = await tabsState();
    await click('#tab-files');
    await until(
      `window.__smoke.attr('data-panel-collapsed') === 'false'`,
      'the Files tab on the start page',
    );
    await clickAt(
      await evaluate(`window.__smoke.clickPoint('#tab-detail')`),
      'a tab that cannot be chosen',
    );
    const tabsOnStart = await tabsState();
    const tabKept = await evaluate(
      `JSON.parse(localStorage.getItem('architecture-map.control-panel') ?? '{}').tab ?? null`,
    );
    check(
      'on the start page only Files can be chosen, and it is the tab shown',
      same(tabsReloaded.selected, ['tab-files']) &&
        same(
          tabsReloaded.disabled,
          tabNames.filter((name) => name !== 'files').map((name) => `tab-${name}`),
        ) &&
        same(tabsOnStart.disabled, tabsReloaded.disabled) &&
        same(tabsOnStart.selected, ['tab-files']) &&
        same(tabsOnStart.shown, ['panel-files']) &&
        tabsOnStart.tab === 'files' &&
        tabsOnStart.collapsed === 'false',
      { tabsReloaded, tabsOnStart },
    );
    await dropFiles(dataFiles);
    await mapShown();
    check(
      'a reload keeps the collapsed panel and, for the map, the tab chosen before',
      tabsReloaded.collapsed === 'true' &&
        tabsReloaded.shown.length === 0 &&
        tabKept === 'layout' &&
        (await showsTab('layout')),
      { tabsReloaded, tabKept, now: await tabsState() },
    );
    // Back to the first tab, for the checks below.
    await click('#tab-detail');
    await until(`window.__smoke.attr('data-panel-tab') === 'detail'`, 'the first tab again');
    await park();

    // --- Work items: loaded next to the structure, room reserved by the layout ---------------
    const work = await evaluate(`(() => {
      const summary = document.querySelector('#workitems-summary');
      const diagnostics = document.querySelector('#diagnostics');
      return {
        items: Number(window.__smoke.attr('data-workitems')),
        origin: summary?.getAttribute('data-origin') ?? null,
        coverage: Number(summary?.getAttribute('data-coverage')),
        mode: window.__smoke.attr('data-story-mode'),
        warnings: Number(diagnostics?.getAttribute('data-warnings')),
        errors: Number(diagnostics?.getAttribute('data-errors')),
      };
    })()`);
    check(
      'work items load from workitems.json, dropped with the structure',
      work.items > 50 && work.origin === 'file' && work.mode === 'stories',
      work,
    );
    check(
      'diagnostics report the unknown comp: tags and the untagged items',
      work.errors === 0 && work.warnings === 3 && work.coverage > 80 && work.coverage < 100,
      work,
    );
    // The story selector lays the map out again: boxes with work items lose their reserved
    // block in mode Off and get more room with the tasks listed.
    const boxHeight = () =>
      evaluate(
        `document.querySelector('.react-flow__node[data-id="storefront"]')?.offsetHeight ?? 0`,
      );
    /** @param {string} mode */
    const chooseStories = async (mode) => {
      await click(`#story-mode [data-story-option="${mode}"]`);
      await until(`window.__smoke.attr('data-story-mode') === '${mode}'`, `story mode ${mode}`);
      await until(`window.__smoke.viewport() !== null`, 'a viewport');
      await sleep(300);
    };
    const heightsPerMode = async () => {
      const stories = await boxHeight();
      await chooseStories('off');
      const off = await boxHeight();
      await chooseStories('tasks');
      const tasks = await boxHeight();
      await chooseStories('stories');
      return { off, stories, tasks, back: await boxHeight() };
    };
    // Below the Everything level no line is drawn, so no room is reserved: the selector must not
    // change a single box there.
    const coarse = await heightsPerMode();
    check(
      'below the Everything level the story selector changes no box',
      coarse.off > 0 && coarse.off === coarse.stories && coarse.stories === coarse.tasks,
      coarse,
    );
    const pinLevel = async (/** @type {string} */ mode, /** @type {string} */ level) => {
      await evaluate(
        `document.querySelector('#lod-indicator [data-lod-option="${mode}"]').click()`,
      );
      await until(`window.__smoke.attr('data-lod') === '${level}'`, `the ${level} level`);
      await until(
        `window.__smoke.attr('data-lines-laid-out') === 'true'`,
        'the layout of that level',
      );
      await sleep(500);
    };
    const levelBefore = await evaluate(`window.__smoke.attr('data-lod')`);
    await pinLevel('detail', 'detail');
    const fine = await heightsPerMode();
    check(
      'at the Everything level the selector reserves room: Off < Stories only < Stories + Tasks',
      fine.off === coarse.off && fine.off < fine.stories && fine.stories < fine.tasks,
      { coarse, fine },
    );
    check('returning to a story mode restores its layout', fine.back === fine.stories, fine);
    await pinLevel('auto', levelBefore);
    check(
      'leaving the Everything level gives the room back',
      (await boxHeight()) === coarse.stories,
      { now: await boxHeight(), coarse },
    );

    // --- Work items on the canvas: badges, lines, tasks, selecting, panel, search, filter ------
    const countOf = (/** @type {string} */ selector) =>
      evaluate(`window.__smoke.count(${JSON.stringify(selector)})`);
    const text = (/** @type {string} */ selector) =>
      evaluate(`window.__smoke.text(${JSON.stringify(selector)})`);
    const pinLod = async (/** @type {string} */ mode, /** @type {string} */ level = mode) => {
      await evaluate(
        `document.querySelector('#lod-indicator [data-lod-option="${mode}"]').click()`,
      );
      await until(`window.__smoke.attr('data-lod') === '${level}'`, `the ${level} level`);
      await until(
        `window.__smoke.attr('data-lines-laid-out') === 'true'`,
        'the layout of that level',
      );
      await sleep(250);
    };
    const drawnProblems = () => evaluate(`window.__smoke.workItemProblems()`);
    check(
      'the control panel names the work-items file',
      (await text('#workitems-source')) === 'workitems.json',
    );
    // The fitted map is zoomed far out: counts, no lines.
    check(
      'zoomed out, nodes show a badge with counts instead of the lines',
      (await countOf('.arch-badge')) > 0 && (await countOf('.arch-workitem')) === 0,
      { badges: await countOf('.arch-badge'), lines: await countOf('.arch-workitem') },
    );
    await pinLod('subcomponents');
    check(
      'at the Subcomponents level there are badges and no lines',
      (await countOf('.arch-badge')) > 0 && (await countOf('.arch-workitem')) === 0,
      { badges: await countOf('.arch-badge'), lines: await countOf('.arch-workitem') },
    );
    check('badges fit their boxes', (await drawnProblems()).length === 0, await drawnProblems());
    await pinLod('detail');
    const storyLines = await countOf('.arch-workitem-item');
    check(
      'at the Everything level the stories are listed, without tasks in Stories only',
      storyLines > 20 &&
        (await countOf('.arch-workitem-task')) === 0 &&
        (await countOf('.arch-badge')) === 0,
      {
        storyLines,
        tasks: await countOf('.arch-workitem-task'),
        badges: await countOf('.arch-badge'),
      },
    );
    check(
      'Stories only: every list fits the room the layout reserved',
      (await drawnProblems()).length === 0,
      await drawnProblems(),
    );
    check(
      'every line has the icon of its type',
      (await countOf('.arch-workitem')) === (await countOf('.arch-workitem > .wi-icon')) &&
        (await countOf('.arch-workitem .wi-icon-story')) > 0 &&
        (await countOf('.arch-workitem .wi-icon-bug')) > 0,
    );
    // A closed group counts what is hidden inside it.
    // (Reaching the Everything level laid the map out again: bring the whole of it back in view.)
    await click('#fit-view');
    await sleep(600);
    await click('.react-flow__node[data-id="storefront"] .arch-chevron');
    await until(`window.__smoke.attr('data-collapsed-count') === '1'`, 'one collapsed group');
    const closedBadge = await evaluate(`(() => {
      const badge = document.querySelector('.react-flow__node[data-id="storefront"] .arch-collapsed-body .arch-badge');
      return badge ? { stories: Number(badge.dataset.stories), bugs: Number(badge.dataset.openBugs) } : null;
    })()`);
    check(
      'a collapsed group shows a badge counting the stories and open bugs inside it',
      closedBadge !== null && closedBadge.stories >= 8 && closedBadge.bugs >= 1,
      closedBadge,
    );
    await evaluate(`document.querySelector('#compact-collapsed').click()`);
    await until(`window.__smoke.count('.arch-group.arch-compact') > 0`, 'a shrunk group');
    check(
      'a shrunk collapsed group has the badge too, inside its box',
      (await countOf('.arch-compact .arch-collapsed-body .arch-badge')) === 1 &&
        (await evaluate(`window.__smoke.compactOverflow()`)).length === 0 &&
        (await drawnProblems()).length === 0,
      {
        overflow: await evaluate(`window.__smoke.compactOverflow()`),
        problems: await drawnProblems(),
      },
    );
    await evaluate(`document.querySelector('#compact-collapsed').click()`);
    await click('#expand-all');
    await until(`window.__smoke.attr('data-collapsed-count') === '0'`, 'everything expanded');

    // Stories + Tasks: the tasks under their story, as their first words.
    await chooseStories('tasks');
    await until(`window.__smoke.count('.arch-workitem-task') > 0`, 'task lines');
    check(
      'Stories + Tasks lists the tasks under their stories',
      (await countOf('.arch-workitem-task')) > 15 &&
        (await countOf('.arch-workitem-task .wi-icon-task')) ===
          (await countOf('.arch-workitem-task')) &&
        (await countOf('.arch-workitem-item')) >= storyLines - 4,
      {
        tasks: await countOf('.arch-workitem-task'),
        stories: await countOf('.arch-workitem-item'),
      },
    );
    check(
      'Stories + Tasks: every list fits the room the layout reserved',
      (await drawnProblems()).length === 0,
      await drawnProblems(),
    );
    // Nothing lies on the lines: no edge across a line (the lists of open groups are drawn above
    // the edges), no edge label over the text of a line. With the whole map on screen.
    await click('#fit-view');
    await settled();
    await sleep(300);
    const cover = await evaluate(`window.__smoke.workItemCover()`);
    check(
      'no edge and no edge label lies on a work-item line',
      cover.lines > 40 && cover.labels > 20 && cover.problems.length === 0,
      cover,
    );
    check(
      'the lists of open groups are drawn above the edges, inside their groups',
      (await countOf('.arch-workitems-above')) > 3 &&
        (await countOf('.react-flow__node-group .arch-workitem')) === 0,
      { above: await countOf('.arch-workitems-above') },
    );
    await pinLod('subcomponents');
    check(
      'lines are drawn at the Everything level only',
      (await countOf('.arch-workitem')) === 0 && (await countOf('.arch-badge')) > 0,
    );
    // Auto: going to a story (search by #id) zooms to where its line is drawn.
    await pinLod('auto', await evaluate(`window.__smoke.attr('data-zoom-lod')`));
    // A story of a domain: the header strip of the group is many times wider than the screen at
    // that zoom, and the line is at its left end.
    await openSearch();
    await client.send('Input.insertText', { text: '#1001' });
    await until(
      `window.__smoke.count('#search-results [data-workitem-id="1001"]') === 1`,
      'the story of the domain among the search results',
    );
    await press('Enter', { keyCode: 13, text: '\r' });
    await untilSelection('workitem:1001');
    await until(`window.__smoke.attr('data-lod') === 'detail'`, 'the Everything level');
    await until(
      `window.__smoke.count('.arch-workitem-selected[data-workitem-id="1001"]') === 1`,
      'the line of the story of the domain',
    );
    await settled();
    check(
      'going to a story of a wide group (a domain) brings its line on screen',
      (await evaluate(`window.__smoke.onScreen('.arch-workitem[data-workitem-id="1001"]')`)) ===
        true &&
        (await evaluate(
          `window.__smoke.onScreen('.react-flow__node[data-id="storefront"] .arch-node-name')`,
        )) === true,
      await evaluate(`window.__smoke.viewport()`),
    );
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await click('#fit-view');
    await settled();
    await until(`window.__smoke.attr('data-lod') !== 'detail'`, 'the fitted map');
    await openSearch();
    await client.send('Input.insertText', { text: '#1010' });
    await until(
      `window.__smoke.count('#search-results [data-workitem-id="1010"]') === 1`,
      'the story among the search results',
    );
    check(
      'search finds a story by #id, listed with its type icon',
      (await countOf('#search-results [role="option"]')) === 1 &&
        (await countOf('#search-results [data-workitem-id="1010"] .wi-icon-story')) === 1,
    );
    await press('Enter', { keyCode: 13, text: '\r' });
    await untilSelection('workitem:1010');
    await until(`window.__smoke.attr('data-lod') === 'detail'`, 'the Everything level');
    await until(
      `window.__smoke.count('.arch-workitem-selected[data-workitem-id="1010"]') === 1`,
      'the line of the story',
    );
    await settled();
    check(
      'going to a story zooms in until its line is drawn, and marks it',
      (await evaluate(`window.__smoke.onScreen('.arch-workitem[data-workitem-id="1010"]')`)) ===
        true,
      await evaluate(`window.__smoke.viewport()`),
    );
    // Fit view at the Everything level takes the lists away: the map is laid out without them
    // and another canvas takes the place of the one on screen. A story gone to at the very
    // moment that canvas appears — it has not started yet — is gone to all the same.
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await openSearch();
    await client.send('Input.insertText', { text: '#1010' });
    await until(
      `window.__smoke.count('#search-results [data-workitem-id="1010"]') === 1`,
      'the story among the search results again',
    );
    await evaluate(`window.__smoke.clickOnNewCanvas('#search-results [data-workitem-id="1010"]')`);
    await evaluate(`document.querySelector('#fit-view').click()`);
    const goneToOnNewCanvas =
      (await eventually(`window.__smoke.newCanvasClicked()`, 'the canvas without the lists')) &&
      (await eventually(
        `window.__smoke.attr('data-selection') === 'workitem:1010' && window.__smoke.attr('data-lod') === 'detail' && window.__smoke.attr('data-lines-laid-out') === 'true' && window.__smoke.count('.arch-workitem-selected[data-workitem-id="1010"]') === 1`,
        'the line of the story after the fit',
      ));
    await settled();
    check(
      'a story gone to at the moment Fit view has another canvas mounted is still gone to: its line ends drawn and on screen',
      goneToOnNewCanvas &&
        (await evaluate(`window.__smoke.onScreen('.arch-workitem[data-workitem-id="1010"]')`)) ===
          true,
      {
        goneToOnNewCanvas,
        lod: await evaluate(`window.__smoke.attr('data-lod')`),
        view: await evaluate(`window.__smoke.viewport()`),
      },
    );
    check(
      'a selected work item dims the nodes that do not show it',
      (await countOf('.react-flow__node.arch-dimmed')) > 0 &&
        (await countOf('.react-flow__node.arch-dimmed[data-id="storefront.web.fraud-check"]')) ===
          0,
    );
    const panel = await evaluate(`(() => {
      const q = (s) => document.querySelector(s)?.textContent ?? '';
      return {
        type: document.querySelector('#detail-panel')?.dataset.selectionType,
        title: q('#detail-title'),
        description: q('#detail-workitem-description'),
        fields: q('#detail-workitem-fields'),
        nodes: [...document.querySelectorAll('#detail-workitem-nodes [data-node-id]')].map((e) => e.dataset.nodeId),
        tasks: [...document.querySelectorAll('#detail-workitem-tasks .detail-workitem-title')].map((e) => e.textContent),
        canvasTask: q('.arch-workitem-task[data-workitem-id="1011"] .arch-workitem-text'),
        place: document.querySelector('#detail-workitem-place')?.dataset.place,
      };
    })()`);
    check(
      'the work-item panel shows description, parameters and the nodes it is tagged to',
      panel.type === 'workitem' &&
        panel.title.includes('trusted-device') &&
        panel.description.length > 40 &&
        panel.fields.includes('Story Points') &&
        panel.fields.includes('Active') &&
        panel.nodes.includes('storefront.web.fraud-check') &&
        panel.place === 'drawn',
      panel,
    );
    const fullTask = panel.tasks.find((/** @type {string} */ task) =>
      task.startsWith('Send the device'),
    );
    check(
      'the canvas shows the first words of a task, the panel its full text',
      panel.tasks.length === 3 &&
        panel.canvasTask.endsWith('…') &&
        fullTask !== undefined &&
        fullTask.startsWith(panel.canvasTask.slice(0, -1)) &&
        fullTask.length > panel.canvasTask.length + 10,
      { canvas: panel.canvasTask, tasks: panel.tasks },
    );
    check(
      'description and parameters are not on the canvas',
      (await evaluate(
        `document.querySelector('.react-flow').textContent.includes('Story Points')`,
      )) === false,
    );
    if (process.env.SMOKE_SHOT) {
      const shot = await client.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(process.env.SMOKE_SHOT, Buffer.from(shot.data, 'base64'));
    }
    // Clicking lines: a task, then another story.
    await click('.arch-workitem-task[data-workitem-id="1012"]');
    await untilSelection('workitem:1012');
    check(
      'clicking a task line selects the task; its panel links to the parent story',
      (await countOf('#detail-workitem-parent [data-workitem-id="1010"]')) === 1 &&
        (await countOf('.arch-workitem-selected')) === 1,
    );
    await click('#detail-workitem-parent [data-workitem-id="1010"]');
    await untilSelection('workitem:1010');
    await settled();
    await click('#detail-workitem-tasks [data-workitem-id="1013"]');
    await untilSelection('workitem:1013');
    check('story and task link to each other in the panel', true);
    await settled();
    await click('#detail-workitem-nodes [data-node-id="storefront.web.fraud-check"]');
    await untilSelection('node:storefront.web.fraud-check');
    check(
      'the node panel lists the linked work items with their tasks',
      (await countOf('#detail-workitems [data-workitem-id="1010"]')) === 1 &&
        (await countOf('#detail-workitems .detail-workitem-tasks [data-workitem-id="1012"]')) === 1,
    );
    await settled();
    await click('#detail-breadcrumb [data-node-id="storefront.web"]');
    await untilSelection('node:storefront.web');
    check(
      'the panel of a group also lists the work items of the nodes inside it, by node',
      (await countOf('#detail-workitems .detail-workitem-group')) >= 3 &&
        (await countOf(
          '#detail-workitems .detail-workitem-group[data-node-id="storefront.web.fraud-check"] [data-workitem-id="1010"]',
        )) === 1,
      { groups: await countOf('#detail-workitems .detail-workitem-group') },
    );
    await click('#detail-workitems [data-workitem-id="1010"]');
    await untilSelection('workitem:1010');
    await settled();
    await click('.arch-workitem-item[data-workitem-id="1010"]');
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    check(
      'Escape clears a selected work item',
      (await countOf('.arch-workitem-selected')) + (await countOf('#detail-panel')) === 0,
    );
    // A line is a button: Tab reaches it, Enter selects the work item (not the node).
    await evaluate(`document.querySelector('.arch-workitem[data-workitem-id="1010"]').focus()`);
    await press('Enter', { keyCode: 13, text: '\r' });
    await untilSelection('workitem:1010');
    check('a line can be chosen with the keyboard', true);

    // Another story mode keeps the place: the node in the middle stays on the canvas.
    await chooseStories('stories');
    check(
      'changing the story mode keeps the view on the same node',
      (await evaluate(
        `window.__smoke.partlyOnScreen('.react-flow__node[data-id="storefront.web.fraud-check"]')`,
      )) === true && (await selection()) === 'workitem:1010',
      await evaluate(`window.__smoke.viewport()`),
    );
    // A task has no line in Stories only: the panel says so and offers the mode that draws it.
    await click('#detail-workitem-tasks [data-workitem-id="1012"]');
    await untilSelection('workitem:1012');
    check(
      'a task that is not drawn says why, and its story is marked instead',
      (await evaluate(`document.querySelector('#detail-workitem-place')?.dataset.place`)) ===
        'tasks-off' && (await countOf('.arch-workitem-related[data-workitem-id="1010"]')) === 1,
    );

    // Off: nothing on the canvas, at any level; the panel still lists the work items.
    await chooseStories('off');
    check(
      'Off removes lines and badges at the Everything level',
      (await countOf('.arch-workitem')) + (await countOf('.arch-badge')) === 0 &&
        (await evaluate(`window.__smoke.attr('data-lod')`)) === 'detail',
    );
    await pinLod('components');
    check(
      'Off removes the badges at the coarser levels too',
      (await countOf('.arch-workitem')) + (await countOf('.arch-badge')) === 0,
    );
    check(
      'in Off the panel still shows the work item, and says why it is not drawn',
      (await selection()) === 'workitem:1012' &&
        (await evaluate(`document.querySelector('#detail-workitem-place')?.dataset.place`)) ===
          'off',
    );
    await click('#detail-workitem-mode');
    await until(`window.__smoke.attr('data-story-mode') === 'tasks'`, 'the mode the panel offers');
    await sleep(300);
    await click('#detail-workitem-show');
    await until(`window.__smoke.attr('data-lod') === 'detail'`, 'the Everything level');
    await until(
      `window.__smoke.count('.arch-workitem-selected[data-workitem-id="1012"]') === 1`,
      'the line of the task',
    );
    check('"Show on the map" raises the pinned level and marks the line', true);

    // Search by title words; the filter by state and iteration.
    await openSearch();
    await client.send('Input.insertText', { text: 'event archives' });
    await click('#search-results [data-workitem-id="1035"]');
    await untilSelection('workitem:1035');
    check('search finds a story by words of its title', true);
    const filterCount = () => text('#workitem-filter-count');
    const allShown = await filterCount();
    const closedLines = await countOf('.arch-workitem-closed');
    await evaluate(`document.querySelector('[data-workitem-state="Closed"]').click()`);
    await until(
      `window.__smoke.text('#workitem-filter-count') !== ${JSON.stringify(allShown)}`,
      'the filter',
    );
    await until(`window.__smoke.attr('data-selection') === null`, 'the selection to be cleared');
    await sleep(300);
    check(
      'hiding a state takes its items off the canvas and clears a selection that is hidden',
      closedLines > 0 &&
        (await countOf('.arch-workitem[data-state="Closed"]')) === 0 &&
        (await countOf('.arch-workitem')) > 0,
      { allShown, now: await filterCount(), closedLines },
    );
    await evaluate(`(() => {
      const select = document.querySelector('#workitem-iteration');
      const option = [...select.options].find((o) => o.value.endsWith('Sprint 14'));
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, option.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until(
      `document.querySelector('#workitem-iteration').value.endsWith('Sprint 14') && window.__smoke.count('.arch-workitem[data-workitem-id="1010"]') === 0`,
      'the iteration filter',
    );
    await sleep(300);
    const covered = await evaluate(`(() => {
      const summary = document.querySelector('#workitems-summary');
      return {
        items: Number(summary.dataset.items),
        covered: Number(summary.dataset.covered),
        shown: window.__smoke.text('#workitem-filter-count'),
        text: summary.textContent,
      };
    })()`);
    check(
      'the tag coverage covers the items the filter shows',
      covered.covered > 0 &&
        covered.covered < covered.items &&
        covered.shown === `${covered.covered} of ${covered.items}` &&
        covered.text.includes(`(${covered.covered} shown)`),
      covered,
    );
    check(
      'the iteration filter leaves the items of that iteration',
      (await countOf('.arch-workitem[data-workitem-id="1017"]')) === 1 &&
        (await drawnProblems()).length === 0,
      await drawnProblems(),
    );
    await client.send('Page.navigate', { url: pathToFileURL(viewerPath).href });
    await startPage();
    const secondStart = await startState();
    check(
      'after a reload the start page offers the map opened before, and opens nothing unasked',
      secondStart.recent.length === 1 &&
        secondStart.recent[0] === 'architecture.yaml + workitems.json' &&
        secondStart.nodes === 0,
      secondStart,
    );
    await dropFiles(dataFiles);
    await mapShown();
    const secondRecent = await recentState();
    check(
      'the same files opened again are the same recent map, not a second one',
      secondRecent.entries.length === 1 && secondRecent.entries[0].current,
      secondRecent,
    );
    check(
      'a reload restores the story mode and the work-item filter',
      (await evaluate(`window.__smoke.attr('data-story-mode')`)) === 'tasks' &&
        (await evaluate(`document.querySelector('#workitem-iteration').value`)).endsWith(
          'Sprint 14',
        ) &&
        (await evaluate(`document.querySelector('[data-workitem-state="Closed"]').checked`)) ===
          false,
    );
    // Back to the defaults for the checks below.
    await evaluate(`(() => {
      const select = document.querySelector('#workitem-iteration');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, '');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until(`document.querySelector('#workitem-iteration').value === ''`, 'all iterations');
    await evaluate(`document.querySelector('[data-workitem-state="Closed"]').click()`);
    await until(
      `window.__smoke.text('#workitem-filter-count') === ${JSON.stringify(allShown)}`,
      'the filter off',
    );
    await sleep(300);
    await chooseStories('stories');
    // The diagnostics list the work-item findings under their own heading, with the coverage.
    await click('#diagnostics .diagnostics-toggle');
    await until(`window.__smoke.count('#diagnostics-workitems') === 1`, 'the diagnostics list');
    check(
      'diagnostics group the work-item findings under a heading with the tag coverage',
      (await text('#diagnostics-workitems h3')).includes('workitems.json') &&
        Number(await evaluate(`document.querySelector('#tag-coverage').dataset.percent`)) ===
          work.coverage &&
        (await countOf('#diagnostics-workitems .diagnostic-warning')) === 3,
    );
    await click('#diagnostics .diagnostics-toggle');
    await click('#fit-view');
    await sleep(600);
    const nodesAtStart = await evaluate(`window.__smoke.count('.react-flow__node')`);
    const bands = await evaluate(`window.__smoke.count('.react-flow__node-band')`);

    // --- Click a node: selection, panel, dimming --------------------------------------------
    await click('.react-flow__node[data-id="platform"] .arch-group-header');
    await untilSelection('node:platform');
    check(
      'click selects a node and opens the panel',
      (await evaluate(`document.querySelector('#detail-title')?.textContent`)) !== undefined,
    );
    check(
      'selected node is marked',
      (await evaluate(`window.__smoke.count('.react-flow__node.selected[data-id="platform"]')`)) ===
        1,
    );
    const dimmed = await evaluate(`window.__smoke.count('.react-flow__node.arch-dimmed')`);
    check(
      'nodes outside the neighbourhood are dimmed, none hidden',
      dimmed > 0 && (await evaluate(`window.__smoke.count('.react-flow__node')`)) === nodesAtStart,
      { dimmed },
    );
    check(
      'row bands are never dimmed',
      (await evaluate(`window.__smoke.count('.react-flow__node-band.arch-dimmed')`)) === 0 &&
        bands > 0,
    );
    check(
      'edges outside the neighbourhood are dimmed',
      (await evaluate(`window.__smoke.count('.react-flow__edge.arch-dimmed')`)) > 0,
    );
    check(
      'the detail panel and the control panel leave the canvas between them',
      await evaluate(`(() => {
        const box = (selector) => document.querySelector(selector).getBoundingClientRect();
        const [controls, canvas, detail] = ['#control-panel', '#map-canvas', '#detail-panel'].map(box);
        return controls.right <= canvas.left + 1 && canvas.right <= detail.left + 1 && canvas.width > 0;
      })()`),
    );

    // --- Escape and empty canvas clear --------------------------------------------------------
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    check(
      'Escape clears the selection and the dimming',
      (await evaluate(
        `window.__smoke.count('.arch-dimmed') + window.__smoke.count('#detail-panel')`,
      )) === 0,
    );
    await click('.react-flow__node[data-id="platform"] .arch-group-header');
    await untilSelection('node:platform');
    await clickAt(await evaluate(`window.__smoke.emptyPoint()`), 'the empty canvas');
    await untilSelection(null);
    check('click on the empty canvas clears the selection', true);

    // --- Minimap: fixed scale, the view cut off at its edge, drag / click / wheel --------------
    await click('#fit-view');
    await sleep(600);
    const miniMap = () => evaluate(`window.__smoke.minimap('platform')`);
    const centreOf = (
      /** @type {{ left: number, right: number, top: number, bottom: number }} */ r,
    ) => ({
      x: (r.left + r.right) / 2,
      y: (r.top + r.bottom) / 2,
    });
    const miniFitted = await miniMap();
    check(
      'the minimap shows the map with the view rectangle inside it',
      miniFitted.svg !== null &&
        miniFitted.node !== null &&
        miniFitted.view !== null &&
        miniFitted.nodes > bands &&
        miniFitted.node.width > 1 &&
        miniFitted.node.left >= miniFitted.svg.left &&
        miniFitted.node.right <= miniFitted.svg.right &&
        miniFitted.view.left < miniFitted.svg.right &&
        miniFitted.view.right > miniFitted.svg.left,
      miniFitted,
    );
    // Pan the map far to the left with the mouse: the view now reaches past its right edge.
    const viewFitted = await evaluate(`window.__smoke.viewport()`);
    const grab = await evaluate(`window.__smoke.emptyPoint()`);
    await drag(grab, { x: grab.x - 700, y: grab.y });
    await settled();
    const viewPanned = await evaluate(`window.__smoke.viewport()`);
    const miniPanned = await miniMap();
    check('dragging the canvas pans the view', viewPanned.x < viewFitted.x - 600, {
      viewFitted,
      viewPanned,
    });
    check(
      'the minimap keeps its scale when the view is panned off the map',
      Math.abs(miniPanned.node.width - miniFitted.node.width) < 0.01 &&
        Math.abs(miniPanned.node.left - miniFitted.node.left) < 0.01 &&
        Math.abs(miniPanned.svg.width - miniFitted.svg.width) < 0.01 &&
        Math.abs(miniPanned.view.width - miniFitted.view.width) < 0.01,
      { before: miniFitted.node, after: miniPanned.node },
    );
    check(
      'the view rectangle is cut off at the edge of the minimap',
      miniPanned.view.right > miniPanned.svg.right + 5 &&
        miniPanned.view.left < miniPanned.svg.right &&
        miniPanned.view.left > miniFitted.view.left + 5 &&
        (await evaluate(`getComputedStyle(document.querySelector('#minimap')).overflow`)) !==
          'visible',
      { svg: miniPanned.svg, view: miniPanned.view },
    );
    // Press in the minimap: that point becomes the middle of the view; dragging keeps doing so.
    const pressAt = { x: miniPanned.svg.left + 60, y: miniPanned.svg.top + 60 };
    const dragTo = { x: miniPanned.svg.left + 120, y: miniPanned.svg.top + 90 };
    await drag(pressAt, pressAt, { hold: true });
    const miniPressed = await miniMap();
    const pressedCentre = centreOf(miniPressed.view);
    check(
      'pressing in the minimap jumps there',
      Math.abs(pressedCentre.x - pressAt.x) < 1.5 && Math.abs(pressedCentre.y - pressAt.y) < 1.5,
      { pressAt, pressedCentre },
    );
    await drag(pressAt, dragTo);
    await settled();
    const miniDragged = await miniMap();
    const viewDragged = await evaluate(`window.__smoke.viewport()`);
    const draggedCentre = centreOf(miniDragged.view);
    check(
      'dragging in the minimap moves the view with the pointer',
      Math.abs(draggedCentre.x - dragTo.x) < 1.5 &&
        Math.abs(draggedCentre.y - dragTo.y) < 1.5 &&
        Math.abs(viewDragged.x - viewPanned.x) > 100 &&
        Math.abs(viewDragged.zoom - viewPanned.zoom) < 1e-9,
      { dragTo, draggedCentre, viewPanned, viewDragged },
    );
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: dragTo.x,
      y: dragTo.y,
      deltaX: 0,
      deltaY: -300,
    });
    await until(
      `Math.abs(window.__smoke.viewport().zoom - ${viewDragged.zoom * 2}) < 0.01`,
      'the zoom after a wheel turn over the minimap',
    );
    const miniZoomed = await miniMap();
    const zoomedCentre = centreOf(miniZoomed.view);
    check(
      'the wheel over the minimap zooms the view about its middle, not the minimap',
      Math.abs(miniZoomed.view.width - miniDragged.view.width / 2) < 0.5 &&
        Math.abs(zoomedCentre.x - draggedCentre.x) < 1.5 &&
        Math.abs(zoomedCentre.y - draggedCentre.y) < 1.5 &&
        Math.abs(miniZoomed.node.width - miniFitted.node.width) < 0.01,
      { before: miniDragged.view, after: miniZoomed.view },
    );
    await click('#fit-view');
    await sleep(600);

    // --- Search -------------------------------------------------------------------------------
    await openSearch();
    check(
      '"/" focuses the search box',
      (await evaluate(`document.activeElement?.id`)) === 'search-input',
    );
    check(
      '"/" is not typed into the box',
      (await evaluate(`document.querySelector('#search-input').value`)) === '',
    );
    await client.send('Input.insertText', { text: 'iphone' });
    await until(`window.__smoke.count('#search-results [role="option"]') > 0`, 'search results');
    check(
      'typing lists matches with name and ID',
      (await evaluate(
        `document.querySelector('#search-results [role="option"]').dataset.nodeId`,
      )) === 'storefront.apps.ios',
    );
    await press('Enter', { keyCode: 13, text: '\r' });
    await untilSelection('node:storefront.apps.ios');
    await until(`window.__smoke.attr('data-lod') === 'subcomponents'`, 'the subcomponents level');
    await until(
      `window.__smoke.count('.react-flow__node.selected[data-id="storefront.apps.ios"]') === 1`,
      'the found node',
    );
    await sleep(500); // the animated move
    const found = await evaluate(`window.__smoke.viewport()`);
    check('search zooms far enough in for the node to be drawn', found.zoom > 1.05, found);
    check(
      'search brings the node on screen',
      await evaluate(`window.__smoke.onScreen('.react-flow__node[data-id="storefront.apps.ios"]')`),
    );
    // Level-of-detail buttons: a pinned level overrides the zoom, Auto follows it again.
    const pin = (/** @type {string} */ mode) =>
      evaluate(`document.querySelector('#lod-indicator [data-lod-option="${mode}"]').click()`);
    await pin('domains');
    await until(`window.__smoke.attr('data-lod') === 'domains'`, 'the pinned domains level');
    check(
      'pinning Domains draws domains only, whatever the zoom',
      (await evaluate(
        `window.__smoke.count('.react-flow__node-group, .react-flow__node-leaf') === window.__smoke.count('.arch-level-domain')`,
      )) === true,
    );
    await pin('detail');
    await until(`window.__smoke.attr('data-lod') === 'detail'`, 'the pinned everything level');
    await pin('auto');
    await until(
      `window.__smoke.attr('data-lod') === 'subcomponents'`,
      'the zoom-driven level after Auto',
    );
    check(
      'Auto follows the zoom again',
      (await evaluate(`window.__smoke.attr('data-lod-mode')`)) === 'auto',
    );
    check(
      'search box is cleared and closed',
      (await evaluate(
        `document.querySelector('#search-input').value + window.__smoke.count('#search-results')`,
      )) === '0',
    );

    await openSearch('k');
    check(
      'Ctrl+K focuses the search box',
      (await evaluate(`document.activeElement?.id`)) === 'search-input',
    );
    await client.send('Input.insertText', { text: 'event store' });
    await click('#search-results [data-node-id="data.event-store"]');
    await untilSelection('node:data.event-store');
    check('a search result can be chosen with the mouse', true);

    // --- Node panel links ---------------------------------------------------------------------
    await openSearch();
    await client.send('Input.insertText', { text: 'storefront.apps.ios' });
    await press('Enter', { keyCode: 13, text: '\r' });
    await untilSelection('node:storefront.apps.ios');
    check(
      'panel shows the row of the node',
      (await evaluate(`document.querySelector('#detail-row')?.textContent ?? ''`)) !== '',
    );
    await click('#detail-outgoing [data-edge-id="ios-to-tracker"]');
    await untilSelection('edge:ios-to-tracker');
    await until(`window.__smoke.count('.react-flow__edge.selected') === 1`, 'the selected edge');
    check(
      'an edge in the node panel selects that edge',
      (await evaluate(`document.querySelector('#detail-panel').dataset.selectionType`)) === 'edge',
    );
    await click('#detail-ends [data-node-id="storefront.web.tracker"]');
    await untilSelection('node:storefront.web.tracker');
    await click('#detail-breadcrumb [data-node-id="storefront.web"]');
    await untilSelection('node:storefront.web');
    check('edge ends and breadcrumb are clickable', true);
    await click('#detail-children [data-node-id="storefront.web.fraud-check"]');
    await untilSelection('node:storefront.web.fraud-check');
    check('children are clickable', true);

    // --- Click an edge on the canvas --------------------------------------------------------
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await settled();
    const single = await until(
      `[...document.querySelectorAll('.react-flow__edge:not(.arch-edge-aggregate)')].map((e) => e.dataset.id).find((id) => window.__smoke.clickPoint('.react-flow__edge[data-id="' + id + '"]') !== null) ?? null`,
      'a clickable edge',
    );
    await click(`.react-flow__edge[data-id="${single}"]`);
    await until(
      `(window.__smoke.attr('data-selection') ?? '').startsWith('edge:')`,
      'an edge selection',
    );
    check(
      'click selects an edge on the canvas',
      (await evaluate(`window.__smoke.count('.react-flow__edge.selected')`)) === 1,
    );
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);

    // Edges running side by side have overlapping hit areas: each must still be selectable by
    // a click on its own line.
    await click('#fit-view');
    await sleep(600);
    const expandedLines = await clickEveryEdge();
    check(
      'every edge is selected by a click on its own line',
      expandedLines.tried > 0 && expandedLines.wrong.length === 0,
      expandedLines,
    );

    // --- Aggregate → member edge --------------------------------------------------------------
    await click('#collapse-all');
    await until(`window.__smoke.count('.react-flow__edge.arch-edge-aggregate') > 0`, 'aggregates');
    await click('#fit-view');
    await sleep(600);
    const collapsedLines = await clickEveryEdge();
    check(
      'between collapsed groups too, aggregates included',
      collapsedLines.tried > 0 && collapsedLines.wrong.length === 0,
      collapsedLines,
    );

    // --- Control panel: its place, shrunk collapsed groups, adjustable thresholds --------------
    const domainWidths = () =>
      evaluate(
        `[...document.querySelectorAll('.react-flow__node-group')].map((n) => n.offsetWidth)`,
      );
    /** @type {number[]} */
    const fullWidths = await domainWidths();
    check(
      'the control panel stands at the left, as tall as the window, and the canvas begins at its right edge',
      (await evaluate(`(() => {
        const panel = document.querySelector('#control-panel').getBoundingClientRect();
        const canvas = document.querySelector('#map-canvas').getBoundingClientRect();
        return (
          panel.width > 0 &&
          panel.left === 0 &&
          panel.top === 0 &&
          Math.abs(panel.bottom - window.innerHeight) < 1 &&
          Math.abs(canvas.left - panel.right) < 1
        );
      })()`)) === true,
    );
    await evaluate(`document.querySelector('#compact-collapsed').click()`);
    await until(`window.__smoke.count('.arch-group.arch-compact') > 0`, 'shrunk groups');
    /** @type {number[]} */
    const shrunkWidths = await domainWidths();
    check(
      'Shrink collapsed groups draws the closed groups smaller, with their contents listed',
      shrunkWidths.length === fullWidths.length &&
        shrunkWidths.every((width, i) => width <= (fullWidths[i] ?? 0)) &&
        shrunkWidths.some((width, i) => width < (fullWidths[i] ?? 0)) &&
        (await evaluate(
          `document.querySelector('.arch-compact .arch-collapsed-body').textContent.includes('· ')`,
        )) === true,
      { fullWidths, shrunkWidths },
    );
    if (process.env.SMOKE_SHOT_SHRUNK) {
      const shot = await client.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(process.env.SMOKE_SHOT_SHRUNK, Buffer.from(shot.data, 'base64'));
    }
    // A shrunk box holds its name and all the names of its contents, however the group was
    // closed: by hand, by a pinned level, or by the zoom (where domain titles are larger).
    const setThreshold = (/** @type {string} */ key, /** @type {number} */ value) =>
      evaluate(`(() => {
        const input = document.querySelector('input[data-threshold="${key}"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '${value}');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    /** @type {string[]} */
    const cutOffGroups = [];
    /** @type {Record<string, number>} */
    const shrunkCounts = {};
    const checkShrunk = async (/** @type {string} */ what) => {
      await sleep(250);
      const shrunk = await evaluate(`window.__smoke.count('.arch-group.arch-compact')`);
      shrunkCounts[what] = shrunk;
      if (shrunk === 0) cutOffGroups.push(`${what}: no shrunk group`);
      /** @type {string[]} */
      const problems = await evaluate(`window.__smoke.compactOverflow()`);
      cutOffGroups.push(...problems.map((problem) => `${what}: ${problem}`));
    };
    await checkShrunk('collapsed by hand');
    await pin('domains');
    await until(`window.__smoke.attr('data-lod') === 'domains'`, 'the pinned domains level');
    await checkShrunk('Domains');
    await pin('components');
    await until(`window.__smoke.attr('data-lod') === 'components'`, 'the pinned components level');
    await checkShrunk('Components');
    await pin('auto');
    await setThreshold('componentsZoom', 3);
    await until(
      `window.__smoke.attr('data-lod') === 'domains' && window.__smoke.attr('data-zoom-lod') === 'domains'`,
      'domains by zoom',
    );
    await checkShrunk('domains by zoom');
    await evaluate(`document.querySelector('#reset-thresholds').click()`);
    check(
      'shrunk groups show their name and all their contents, uncut, at every level',
      cutOffGroups.length === 0 && Object.keys(shrunkCounts).length === 4,
      { cutOffGroups, shrunkCounts },
    );
    await evaluate(`document.querySelector('#compact-collapsed').click()`);
    await until(`window.__smoke.count('.arch-group.arch-compact') === 0`, 'full boxes again');

    // A threshold moved above the current zoom changes the automatic level at once.
    await click('#expand-all');
    await until(`window.__smoke.attr('data-collapsed-count') === '0'`, 'everything expanded');
    const lodBefore = await evaluate(`window.__smoke.attr('data-lod')`);
    await setThreshold('componentsZoom', 3);
    await until(`window.__smoke.attr('data-lod') === 'domains'`, 'domains after raising');
    check('raising the Components threshold above the zoom shows domains only', true, {
      lodBefore,
    });
    await evaluate(`document.querySelector('#reset-thresholds').click()`);
    await until(`window.__smoke.attr('data-lod') === '${lodBefore}'`, 'the level after the reset');
    check('Reset thresholds restores the level', true);
    // Picking a level of detail opens the groups collapsed by hand.
    await click('#collapse-all');
    await until(`window.__smoke.attr('data-collapsed-count') !== '0'`, 'everything collapsed');
    await pin('auto');
    await until(`window.__smoke.attr('data-collapsed-count') === '0'`, 'groups reopened by Auto');
    check('a Detail button reopens the groups collapsed by hand', true);

    // --- Rows hidden, positions moved by hand --------------------------------------------------
    const bandsBefore = await evaluate(`window.__smoke.count('.react-flow__node-band')`);
    await evaluate(`document.querySelector('#show-rows').click()`);
    await until(
      `window.__smoke.attr('data-show-rows') === 'false' &&
        window.__smoke.count('.react-flow__node-band') === 0 &&
        window.__smoke.count('.react-flow__node-group') > 0`,
      'the map without rows',
    );
    check('Arrange in rows off: the map is drawn without row bands', bandsBefore > 0, {
      bandsBefore,
    });
    await evaluate(`document.querySelector('#show-rows').click()`);
    await until(
      `window.__smoke.count('.react-flow__node-band') === ${bandsBefore}`,
      'the row bands again',
    );
    await click('#fit-view');
    await sleep(600);

    /** Screen boxes of the top-level groups, by node ID. */
    const domainBoxes = () =>
      evaluate(`Object.fromEntries(
        [...document.querySelectorAll('.react-flow__node-group')]
          .filter((n) => !n.dataset.id.includes('.'))
          .map((n) => {
            const r = n.getBoundingClientRect();
            return [n.dataset.id, { x: r.left, y: r.top, width: r.width, height: r.height }];
          }),
      )`);
    /** @type {Record<string, { x: number, y: number, width: number, height: number }>} */
    const boxesLocked = await domainBoxes();
    const [movedId, ...otherIds] = Object.keys(boxesLocked);
    const grabbed = boxesLocked[movedId ?? ''];
    if (movedId === undefined || grabbed === undefined) throw new Error('no domain to drag');
    // The header, right of the chevron and the name.
    const grabAt = { x: grabbed.x + grabbed.width - 30, y: grabbed.y + 14 };
    const dropBy = { x: 90, y: 60 };
    const dropAt = { x: grabAt.x + dropBy.x, y: grabAt.y + dropBy.y };

    await drag(grabAt, dropAt);
    await sleep(300);
    check(
      'locked positions: dragging a group pans the view, nothing is stored as moved',
      (await evaluate(`window.__smoke.attr('data-moved-count')`)) === '0',
    );
    await click('#fit-view');
    await sleep(600);

    await click('#unlock-positions');
    await until(`window.__smoke.attr('data-positions-unlocked') === 'true'`, 'unlocked positions');
    await drag(grabAt, dropAt);
    await until(`window.__smoke.attr('data-moved-count') === '1'`, 'one node moved by hand');
    await sleep(200);
    /** @type {typeof boxesLocked} */
    const boxesMoved = await domainBoxes();
    const near = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) <= 3;
    const movedBox = boxesMoved[movedId];
    check(
      'unlocked positions: the dragged group moves by the drag, the other groups stay',
      movedBox !== undefined &&
        // The drag only starts moving the node after its first step, so a little less than the drag.
        movedBox.x - grabbed.x > dropBy.x * 0.6 &&
        movedBox.x - grabbed.x <= dropBy.x + 3 &&
        movedBox.y - grabbed.y > dropBy.y * 0.6 &&
        movedBox.y - grabbed.y <= dropBy.y + 3 &&
        otherIds.length > 0 &&
        otherIds.every((id) => {
          const before = boxesLocked[id];
          const after = boxesMoved[id];
          return (
            before !== undefined &&
            after !== undefined &&
            near(before.x, after.x) &&
            near(before.y, after.y)
          );
        }),
      { before: boxesLocked, after: boxesMoved },
    );
    await click('#reset-positions');
    await until(`window.__smoke.attr('data-moved-count') === '0'`, 'positions reset');
    await sleep(200);
    /** @type {typeof boxesLocked} */
    const boxesReset = await domainBoxes();
    const resetBox = boxesReset[movedId];
    check(
      'Reset positions puts the group back',
      resetBox !== undefined && near(resetBox.x, grabbed.x) && near(resetBox.y, grabbed.y),
      { resetBox, grabbed },
    );
    await click('#unlock-positions');
    await until(`window.__smoke.attr('data-positions-unlocked') === 'false'`, 'locked positions');

    // --- Node panel: lists fold and move; completed work items can be hidden -------------------
    await click('.react-flow__node[data-id="data"] .arch-node-name');
    await untilSelection('node:data');
    const sectionIds = () =>
      evaluate(
        `[...document.querySelectorAll('#detail-sections > section')].map((el) => el.dataset.section)`,
      );
    /** @type {string[]} */
    const sectionsBefore = await sectionIds();
    await click('#detail-incoming .detail-section-toggle');
    await until(
      `document.querySelector('#detail-incoming')?.dataset.collapsed === 'true'`,
      'the folded list',
    );
    check(
      'a list of the node panel folds: heading only',
      (await evaluate(`window.__smoke.count('#detail-incoming .detail-list')`)) === 0 &&
        (await evaluate(`window.__smoke.count('#detail-outgoing .detail-list')`)) === 1,
    );
    await click('#detail-incoming .detail-section-toggle');
    await until(
      `document.querySelector('#detail-incoming')?.dataset.collapsed === 'false'`,
      'the unfolded list',
    );
    await click('#detail-workitems [data-move="up"]');
    await sleep(150);
    /** @type {string[]} */
    const sectionsMoved = await sectionIds();
    const wasAt = sectionsBefore.indexOf('workitems');
    check(
      'a list of the node panel moves up',
      wasAt > 0 &&
        sectionsMoved.indexOf('workitems') === wasAt - 1 &&
        sectionsMoved.length === sectionsBefore.length,
      { sectionsBefore, sectionsMoved },
    );
    await click('#detail-workitems [data-move="down"]');
    await sleep(150);
    check(
      'and back down',
      JSON.stringify(await sectionIds()) === JSON.stringify(sectionsBefore),
      await sectionIds(),
    );
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);

    const shownItems = () =>
      evaluate(
        `Number(document.querySelector('#workitem-filter-count').textContent.split(' ')[0])`,
      );
    const shownAll = await shownItems();
    await evaluate(`document.querySelector('#show-completed').click()`);
    await sleep(400);
    const shownOpen = await shownItems();
    check(
      'Show completed work items off hides the closed ones',
      shownOpen > 0 && shownOpen < shownAll,
      { shownAll, shownOpen },
    );
    await evaluate(`document.querySelector('#show-completed').click()`);
    await sleep(400);
    check('and on shows them again', (await shownItems()) === shownAll);
    // The Everything threshold at the top of its slider: no zoom reaches the level, so going to
    // a work item in Auto pins Everything, or its line would not be drawn.
    await setThreshold('detailZoom', 4);
    await openSearch();
    await client.send('Input.insertText', { text: '#1001' });
    await click('#search-results [data-workitem-id="1001"]');
    await untilSelection('workitem:1001');
    await until(
      `window.__smoke.attr('data-lod-mode') === 'detail' && window.__smoke.count('.arch-workitem-selected[data-workitem-id="1001"]') >= 1`,
      'the pinned Everything level with the line of the story',
    );
    check('going to a work item pins Everything when no zoom reaches that level', true);
    await evaluate(`document.activeElement?.blur()`);
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await evaluate(`document.querySelector('#reset-thresholds').click()`);
    await pin('auto');
    await click('#fit-view');
    await sleep(600);
    await click('#collapse-all');
    await until(`window.__smoke.count('.react-flow__edge.arch-edge-aggregate') > 0`, 'aggregates');
    await sleep(300);

    // An aggregate whose groups are opened is no longer one: the selection must not linger as
    // a "merged edges" panel for what is now a single edge, nor come back by itself.
    const stalePoints = await evaluate(`window.__smoke.edgePoints('storefront>data:dataflow')`);
    await clickAt(stalePoints[Math.floor(stalePoints.length / 2)] ?? null, 'an aggregate');
    await untilSelection('aggregate:storefront>data:dataflow');
    await click('#expand-all');
    await until(`window.__smoke.attr('data-collapsed-count') === '0'`, 'everything expanded');
    await sleep(300);
    const staleAfter = await selection();
    check(
      'an aggregate selection does not outlive its aggregate',
      (staleAfter === null || staleAfter.startsWith('edge:')) &&
        (await evaluate(
          `document.querySelector('#detail-panel')?.dataset.selectionType ?? null`,
        )) !== 'aggregate',
      { staleAfter },
    );
    await click('#collapse-all');
    await until(`window.__smoke.count('.react-flow__edge.arch-edge-aggregate') > 0`, 'aggregates');
    await sleep(300);
    check(
      'a vanished aggregate selection does not come back by itself',
      !((await selection()) ?? '').startsWith('aggregate:'),
    );
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await click('#fit-view');
    await sleep(600);
    const aggregate = await until(
      `[...document.querySelectorAll('.react-flow__edge.arch-edge-aggregate')].map((e) => e.dataset.id).find((id) => window.__smoke.clickPoint('.react-flow__edge[data-id="' + id + '"]') !== null) ?? null`,
      'a clickable aggregate',
    );
    await click(`.react-flow__edge[data-id="${aggregate}"]`);
    await untilSelection(`aggregate:${aggregate}`);
    const members = await evaluate(
      `[...document.querySelectorAll('#detail-members [data-edge-id]')].map((e) => e.dataset.edgeId)`,
    );
    const count = await evaluate(
      `Number(document.querySelector('.arch-edge-label-count[data-edge-id="${aggregate}"]').dataset.count)`,
    );
    check('aggregate panel lists its member edges', members.length === count && count > 1, {
      count,
      members,
    });
    const collapsedBefore = Number(await evaluate(`window.__smoke.attr('data-collapsed-count')`));
    await click(`#detail-members [data-edge-id="${members[0]}"]`);
    await untilSelection(`edge:${members[0]}`);
    await until(`window.__smoke.count('.react-flow__edge.selected') === 1`, 'the member edge');
    await sleep(500);
    check(
      'choosing a member expands the groups around its ends',
      Number(await evaluate(`window.__smoke.attr('data-collapsed-count')`)) < collapsedBefore,
    );
    check(
      'the member edge is drawn on its own and selected',
      (await evaluate(
        `window.__smoke.count('.react-flow__edge.selected:not(.arch-edge-aggregate)')`,
      )) === 1,
    );

    // --- Search results at every window width -------------------------------------------------
    // In a narrow window the open body of the control panel lies over the canvas, and the
    // results list hangs out of it; the list must stay inside the window. It starts at the left
    // edge of the search box where there is room for that, and is pulled left of it in a window
    // narrower than about 460px (the 420 here), keeping its distance from the window edge.
    /** @type {string[]} */
    const cutOff = [];
    for (const width of [1280, 1024, 900, 800, 420, 520]) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 700,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(300);
      await openSearch();
      await client.send('Input.insertText', { text: 'a' });
      await until(`window.__smoke.count('#search-results [role="option"]') > 0`, 'search results');
      await sleep(100);
      const span = await evaluate(
        `(() => { const r = document.querySelector('#search-results').getBoundingClientRect();
          return [r.left, r.right, document.documentElement.clientWidth, document.querySelector('#search').getBoundingClientRect().left].join(' '); })()`,
      );
      const [left = NaN, right = NaN, viewport = NaN, box = NaN] = String(span)
        .split(' ')
        .map(Number);
      const placed = width < 460 ? left < box && right <= viewport - 8 : Math.abs(left - box) < 1;
      if (!(left >= 0 && right <= viewport && placed)) {
        cutOff.push(`${width}: ${left}..${right}, the box at ${box}`);
      }
      await press('Escape', { code: 'Escape', keyCode: 27 });
      await press('Escape', { code: 'Escape', keyCode: 27 });
    }
    check('the search results stay inside the window', cutOff.length === 0, cutOff.join('; '));
    // Still 520 wide: the canvas is as wide under the open body as it is without it.
    const narrow = { body: await sides('#control-panel-body'), canvas: await sides('#map-canvas') };
    await togglePanel(true);
    const narrowCollapsed = await sides('#map-canvas');
    await togglePanel(false);
    check(
      'in a narrow window the open control panel lies over the canvas, which keeps its width',
      narrow.body.width > 0 &&
        narrow.body.left >= narrow.canvas.left - 1 &&
        narrow.body.right > narrow.canvas.left + 1 &&
        narrow.canvas.width > 0 &&
        Math.abs(narrow.canvas.width - narrowCollapsed.width) < 1,
      { ...narrow, collapsed: narrowCollapsed },
    );
    // Only the canvas lies under the open body. What else stands at the left of the column
    // begins beside it: the notice above the canvas with its controls, the legend and the zoom
    // buttons on the canvas, and the diagnostics below it.
    await evaluate(`window.__smoke.choose('#focus-select', 'flow:campaign-run')`);
    await until(`window.__smoke.count('#focus-bar') === 1`, 'the focus bar');
    await settled();
    const besideBody = await evaluate(`(() => {
      const left = (selector) => document.querySelector(selector).getBoundingClientRect().left;
      return {
        body: document.querySelector('#control-panel-body').getBoundingClientRect().right,
        barText: left('.focus-bar-text'),
        legend: left('#edge-legend'),
        zoom: left('.react-flow__controls'),
        diagnostics: left('.diagnostics-toggle'),
        reachable: ['#focus-bar-mode', '#focus-clear'].filter(
          (selector) => window.__smoke.clickPoint(selector) !== null,
        ),
      };
    })()`);
    await click('#focus-clear');
    await until(`window.__smoke.attr('data-focus') === null`, 'the focus cleared in the bar');
    check(
      'in a narrow window the focus bar, the legend, the zoom buttons and the diagnostics begin beside the open control panel, and the bar can be used',
      besideBody.body > narrow.canvas.left + 1 &&
        ['barText', 'legend', 'zoom', 'diagnostics'].every(
          (part) => besideBody[part] >= besideBody.body,
        ) &&
        besideBody.reachable.length === 2,
      besideBody,
    );
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    // In a window too low for a tab, the tabs scroll in one area: another tab starts at its top,
    // not where the tab before it was left.
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 520,
      height: 400,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(300);
    await showControl('#focus-select');
    const scrolledTab = await evaluate(`(() => {
      const area = document.querySelector('.cp-panels');
      area.scrollTop = area.scrollHeight;
      return area.scrollTop;
    })()`);
    await clickAt(await evaluate(`window.__smoke.clickPoint('#tab-detail')`), 'the Detail tab');
    await until(`window.__smoke.attr('data-panel-tab') === 'detail'`, 'the Detail tab');
    const otherTab = await evaluate(`(() => {
      const area = document.querySelector('.cp-panels');
      return { top: area.scrollTop, scrolls: area.scrollHeight > area.clientHeight };
    })()`);
    check(
      'another tab of the control panel starts at its top, wherever the one before was scrolled to',
      scrolledTab > 0 && otherTab.scrolls && otherTab.top === 0,
      { scrolledTab, otherTab },
    );
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 520,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(300);

    // --- Long edges on a small window ---------------------------------------------------------
    // When both ends do not fit at the zoom that draws them, the source is the end shown. With
    // the body of the control panel collapsed: open, it would lie over the canvas in this window.
    await togglePanel(true);
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1156,
      height: 640,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(300);
    /** @type {string[]} */
    const offScreen = [];
    for (const { node, edge, section, source } of [
      {
        node: 'data.ingest.broker',
        edge: 'broker-trust',
        section: 'outgoing',
        source: 'data.ingest.broker',
      },
      {
        node: 'storefront.web.fraud-check',
        edge: 'fraud-to-alerts',
        section: 'outgoing',
        source: 'storefront.web.fraud-check',
      },
      {
        node: 'operations.oms.order-manager',
        edge: 'released-rules',
        section: 'incoming',
        source: 'backoffice.config-manager.version-store',
      },
    ]) {
      await openSearch();
      await client.send('Input.insertText', { text: node });
      await press('Enter', { keyCode: 13, text: '\r' });
      await untilSelection(`node:${node}`);
      await click(`#detail-${section} [data-edge-id="${edge}"]`);
      await untilSelection(`edge:${edge}`);
      await sleep(500);
      await settled();
      const shown = await evaluate(
        `window.__smoke.onScreen('.react-flow__node[data-id="${source}"]')`,
      );
      if (!shown) offScreen.push(edge);
    }
    check('going to a long edge shows its source end', offScreen.length === 0, offScreen);
    await client.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
    await togglePanel(false);

    // --- Lenses, focus, saved views, hints ------------------------------------
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await click('#expand-all');
    await until(`window.__smoke.attr('data-collapsed-count') === '0'`, 'everything expanded');
    await pinLod('components');
    await click('#fit-view');
    await sleep(600);
    const setSetting = async (/** @type {string} */ id, /** @type {boolean} */ on) => {
      const checked = await evaluate(`document.querySelector('#${id}').checked`);
      if (checked !== on) await evaluate(`document.querySelector('#${id}').click()`);
      await sleep(250);
    };
    const chooseOption = async (/** @type {string} */ selector, /** @type {string} */ value) => {
      await evaluate(
        `window.__smoke.choose(${JSON.stringify(selector)}, ${JSON.stringify(value)})`,
      );
      await sleep(300);
    };
    // Hints: the example describes most nodes, not all.
    check(
      'the diagnostics panel counts the hints for the author',
      Number(await evaluate(`document.querySelector('#diagnostics')?.dataset.hints`)) >= 1 &&
        (await text('#diagnostics .badge-hint')).endsWith('hint'),
    );
    // Focus on a flow: its panel, its steps, and everything else paled.
    const focusOptions = await evaluate(
      `[...document.querySelectorAll('#focus-select option')].map((o) => o.value)`,
    );
    check(
      'the Focus selector offers the flows and the epics and features',
      focusOptions.includes('flow:telemetry-to-dashboards') &&
        focusOptions.includes('workitem:1001') &&
        focusOptions[0] === '',
      focusOptions,
    );
    await chooseOption('#focus-select', 'flow:telemetry-to-dashboards');
    await until(
      `window.__smoke.attr('data-focus') === 'flow:telemetry-to-dashboards'`,
      'the focus on the flow',
    );
    await untilSelection('flow:telemetry-to-dashboards');
    await settled();
    check(
      'a focused flow opens its panel with its steps in order and says what it involves',
      (await countOf('#detail-flow-steps li')) === 7 &&
        (await text('#detail-flow-steps li:first-child .detail-edge-label')).includes(
          'page events',
        ) &&
        (await text('#focus-bar')).includes('8 nodes') &&
        (await countOf('#detail-panel .detail-focus-active')) === 1,
      { bar: await text('#focus-bar') },
    );
    check(
      'the focus pales what the flow does not involve and keeps what it does',
      (await countOf('.react-flow__node.arch-faded')) > 0 &&
        (await countOf('.react-flow__node.arch-faded[data-id="data.event-store"]')) === 0 &&
        (await countOf('.react-flow__node.arch-faded[data-id="data"]')) === 0 &&
        (await countOf('.react-flow__node.arch-faded[data-id="platform"]')) === 1 &&
        (await countOf('.react-flow__edge.arch-faded')) > 0 &&
        (await countOf('.react-flow__node.arch-band.arch-faded')) === 0,
    );
    await click('#focus-clear');
    await until(`window.__smoke.attr('data-focus') === null`, 'the focus cleared');
    check('clearing the focus pales nothing', (await countOf('.arch-faded')) === 0);
    // Focus on an epic: the nodes of everything under it.
    await chooseOption('#focus-select', 'workitem:1001');
    await until(`window.__smoke.attr('data-focus') === 'workitem:1001'`, 'the focus on the epic');
    await click('#focus-show');
    await untilSelection('workitem:1001');
    await settled();
    check(
      'a focused epic lights the nodes of its stories and tasks, and its panel shows the focus',
      (await countOf('.react-flow__node.arch-faded')) > 0 &&
        (await countOf('.react-flow__node.arch-faded[data-id="storefront"]')) === 0 &&
        (await evaluate(
          `document.querySelector('[data-focus-button="workitem:1001"]')?.getAttribute('aria-pressed')`,
        )) === 'true',
    );
    await click('[data-focus-button="workitem:1001"]');
    await until(`window.__smoke.attr('data-focus') === null`, 'the focus cleared again');
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);

    // --- Focus / Filter: the map reduced to what the focus involves ---------------------------
    // At a level that draws every node, with every group open: the whole map has all 45.
    const tabBeforeFilter = await evaluate(`window.__smoke.attr('data-panel-tab')`);
    await pinLod('subcomponents');
    await click('#fit-view');
    await settled();
    const attr = (/** @type {string} */ name) =>
      evaluate(`window.__smoke.attr(${JSON.stringify(name)})`);
    const viewNow = () => evaluate(`window.__smoke.viewport()`);
    /** Holds in the page once the viewport kept for the whole map is the view on screen. */
    const viewIsStored = `(() => {
      const stored = JSON.parse(window.__smoke.storedViewport() ?? 'null');
      const view = window.__smoke.viewport();
      return stored !== null && Math.abs(stored.x - view.x) < 1 && Math.abs(stored.y - view.y) < 1 && Math.abs(stored.zoom - view.zoom) < 0.001;
    })()`;
    /**
     * Waits for the map that is wanted — filtered to that focus, or the whole one (null) — to be
     * on screen and at rest.
     * @param {string | null} focus
     */
    const untilFiltered = async (focus) => {
      await until(
        `window.__smoke.attr('data-filtered') === ${JSON.stringify(focus)} && window.__smoke.attr('data-lines-laid-out') === 'true' && window.__smoke.viewport() !== null`,
        focus === null ? 'the whole map' : `the map filtered to ${focus}`,
      );
      await settled();
    };
    /**
     * How the map on screen sits in the canvas. It is fitted when every node is on the canvas
     * and Fit view leaves the view as it is: `off` are the nodes that are not, `view` and
     * `refitted` the view before and after Fit view.
     */
    const fitOnScreen = async () => {
      await settled();
      const view = await viewNow();
      /** @type {string[]} */
      const off = await evaluate(`window.__smoke.offCanvas()`);
      await click('#fit-view');
      await settled();
      const refitted = await viewNow();
      return { fitted: off.length === 0 && sameView(view, refitted), off, view, refitted };
    };
    const switchState = () =>
      evaluate(`(() => {
        const control = document.querySelector('#focus-mode');
        return {
          role: control?.getAttribute('role') ?? null,
          checked: control?.getAttribute('aria-checked') ?? null,
          hint: window.__smoke.text('#focus-mode-hint'),
          mode: window.__smoke.attr('data-focus-mode'),
          filtered: window.__smoke.attr('data-filtered'),
          nodes: window.__smoke.attr('data-drawn-nodes'),
          edges: window.__smoke.attr('data-drawn-edges'),
        };
      })()`);
    const switchAtStart = await switchState();
    check(
      'the Focus / Filter switch is off at first: a focus pales the rest of the map',
      switchAtStart.role === 'switch' &&
        switchAtStart.checked === 'false' &&
        switchAtStart.mode === 'focus' &&
        switchAtStart.filtered === null &&
        switchAtStart.nodes === '45' &&
        switchAtStart.hint === 'The rest of the map is paled.',
      switchAtStart,
    );
    // A node without a row of its own, placed in one by its connections: marked as such.
    const placedMark =
      '.react-flow__node[data-id="data.analytics.feature-store"] .arch-node-placed';
    const placedOnWhole = await countOf(placedMark);
    const groupsOnWhole = await countOf('.react-flow__node-group');

    // Focus first: what stays unfaded is what Filter is to draw.
    const flowFocus = 'flow:telemetry-to-dashboards';
    await chooseOption('#focus-select', flowFocus);
    await until(`window.__smoke.attr('data-focus') === '${flowFocus}'`, 'the focus on the flow');
    await untilSelection(flowFocus);
    await settled();
    const unfaded = {
      nodes: await evaluate(`window.__smoke.nodeIds(':not(.arch-faded)')`),
      edges: await evaluate(
        `[...document.querySelectorAll('.react-flow__edge:not(.arch-faded)')].map((e) => e.dataset.id).sort()`,
      ),
    };
    /** The edges of the flow, as its panel lists them. @type {string[]} */
    const flowSteps = await evaluate(
      `[...document.querySelectorAll('#detail-flow-steps [data-edge-id]')].map((step) => step.dataset.edgeId)`,
    );
    const viewFocused = await viewNow();
    // The height of the hint under the switch in every frame from here on: while the reduced
    // map is laid out the hint says so on one line, like the texts before and after it.
    await showControl('#focus-mode');
    await evaluate(`(() => {
      const seen = new Set();
      window.__hintHeights = seen;
      const step = () => {
        seen.add(Math.round(document.querySelector('#focus-mode-hint').getBoundingClientRect().height));
        if (window.__hintHeights === seen) requestAnimationFrame(step);
      };
      step();
    })()`);
    await click('#focus-mode');
    await until(`window.__smoke.attr('data-focus-mode') === 'filter'`, 'Filter mode');
    await untilFiltered(flowFocus);
    /** @type {number[]} */
    const hintHeights = await evaluate(`(() => {
      const seen = [...window.__hintHeights];
      window.__hintHeights = null;
      return seen;
    })()`);
    const switchOn = await switchState();
    check(
      'the switch turns Filter on: the map is reduced to the 14 nodes and 7 edges of the focused flow',
      switchOn.checked === 'true' &&
        switchOn.mode === 'filter' &&
        switchOn.filtered === flowFocus &&
        switchOn.nodes === '14' &&
        switchOn.edges === '7',
      switchOn,
    );
    const drawnFiltered = {
      nodes: await evaluate(`window.__smoke.nodeIds()`),
      edges: (await evaluate(`window.__smoke.edgeIds()`)).sort(),
    };
    check(
      'Filter draws exactly what Focus leaves unfaded, and pales nothing',
      same(drawnFiltered, unfaded) &&
        drawnFiltered.nodes.length === 14 &&
        drawnFiltered.edges.length === 7 &&
        (await countOf('.arch-faded')) === 0 &&
        drawnFiltered.nodes.includes('data.event-store') &&
        drawnFiltered.nodes.includes('data') &&
        !drawnFiltered.nodes.includes('platform'),
      { unfaded, drawnFiltered },
    );
    const fitFiltered = await fitOnScreen();
    const viewFiltered = fitFiltered.view;
    check(
      'the filtered map is laid out again and fitted: every node on the canvas, drawn no smaller than before',
      fitFiltered.fitted && viewFiltered.zoom >= viewFocused.zoom,
      { viewFocused, ...fitFiltered },
    );
    const barFiltered = await text('#focus-bar');
    check(
      'the focus bar and the hint at the switch say what Filter leaves out',
      barFiltered.startsWith('Filter:') &&
        barFiltered.includes('8 nodes') &&
        barFiltered.includes('the rest of the map is not drawn') &&
        (await evaluate(`document.querySelector('#focus-bar').dataset.mode`)) === 'filter' &&
        (await evaluate(
          `document.querySelector('#focus-bar-mode').getAttribute('aria-checked')`,
        )) === 'true' &&
        (await text('#focus-mode-hint')) === 'Not drawn: 31 of 45 nodes.',
      { barFiltered, hint: await text('#focus-mode-hint') },
    );
    check(
      'the hint at the switch keeps its height while the reduced map is laid out: nothing below it moves',
      hintHeights.length === 1 && Number(hintHeights[0]) > 0,
      hintHeights,
    );
    // The detail panel lists the whole model: what the filtered map leaves out is marked there.
    await click('.react-flow__node[data-id="data.analytics"] .arch-node-name');
    await untilSelection('node:data.analytics');
    /** @type {{ id: string, outside: boolean, title: string }[]} */
    const nodeLinks = await evaluate(
      `[...document.querySelectorAll('#detail-panel .detail-link[data-node-id]')].map((link) => ({ id: link.dataset.nodeId, outside: link.dataset.outside === 'true', title: link.title }))`,
    );
    /** @type {{ id: string, outside: boolean, title: string }[]} */
    const edgeLinks = await evaluate(
      `[...document.querySelectorAll('#detail-panel .detail-edge[data-edge-id]')].map((link) => ({ id: link.dataset.edgeId, outside: link.dataset.outside === 'true', title: link.title }))`,
    );
    const marked = [...nodeLinks, ...edgeLinks].filter((link) => link.outside);
    check(
      'the panel of a node on the filtered map marks the links to nodes and edges that are not drawn',
      nodeLinks.some((link) => link.outside) &&
        nodeLinks.every((link) => link.outside !== drawnFiltered.nodes.includes(link.id)) &&
        flowSteps.length === 7 &&
        edgeLinks.some((link) => link.outside) &&
        edgeLinks.every((link) => link.outside !== flowSteps.includes(link.id)) &&
        marked.every((link) => link.title.includes('not on the filtered map')),
      { nodeLinks, edgeLinks, flowSteps },
    );
    // The view of a filtered map is its own: moving it stores nothing.
    const storedWhole = await evaluate(`window.__smoke.storedViewport()`);
    const hold = await evaluate(`window.__smoke.emptyPoint()`);
    await drag(hold, { x: hold.x - 150, y: hold.y + 40 });
    await settled();
    const viewMoved = await viewNow();
    await sleep(600); // a view that is stored would be by now
    check(
      'panning the filtered map leaves the stored viewport of the whole map as it is',
      storedWhole !== null &&
        viewMoved.x < viewFiltered.x - 100 &&
        (await evaluate(`window.__smoke.storedViewport()`)) === storedWhole,
      { storedWhole, now: await evaluate(`window.__smoke.storedViewport()`), viewMoved },
    );
    // Leaving Filter is a round trip: the whole map is back where it was. The switch that does
    // it stays where it is, under the pointer, although the text of the bar gets shorter.
    const switchFiltered = await sides('#focus-bar-mode');
    await click('#focus-bar-mode');
    await until(`window.__smoke.attr('data-focus-mode') === 'focus'`, 'Focus mode');
    await untilFiltered(null);
    const switchFocused = await sides('#focus-bar-mode');
    check(
      'the switch in the focus bar stays in its place when it is used',
      Math.abs(switchFocused.left - switchFiltered.left) < 4 &&
        Math.abs(switchFocused.right - switchFiltered.right) < 4,
      { switchFiltered, switchFocused },
    );
    const viewBack = await viewNow();
    // The component selected on the filtered map is still selected: besides what the flow
    // involves, what is drawn inside it is not paled either. Without the selection the focus
    // pales exactly what it paled before Filter.
    /** @type {string[]} */
    const unfadedSelected = await evaluate(`window.__smoke.nodeIds(':not(.arch-faded)')`);
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    check(
      'the switch in the focus bar turns Filter off: the whole map is back, paled, in the view it had',
      (await attr('data-drawn-nodes')) === '45' &&
        (await countOf('.react-flow__node.arch-faded')) > 0 &&
        same(await evaluate(`window.__smoke.nodeIds(':not(.arch-faded)')`), unfaded.nodes) &&
        unfaded.nodes.every((/** @type {string} */ id) => unfadedSelected.includes(id)) &&
        unfadedSelected
          .filter((id) => !unfaded.nodes.includes(id))
          .every((id) => id.startsWith('data.analytics.')) &&
        sameView(viewBack, viewFocused),
      { viewFocused, viewBack, unfadedSelected },
    );
    // What is selected stays selected when Filter leaves it out: its panel says so and offers
    // the way to it. (The whole map in view first, to click a domain the flow does not involve.)
    await click('#fit-view');
    await settled();
    await click('.react-flow__node[data-id="platform"] .arch-group-header');
    await untilSelection('node:platform');
    await click('#focus-mode');
    await untilFiltered(flowFocus);
    const outsideNote = await text('#detail-outside-note');
    check(
      'a node selected before Filter leaves it out keeps its panel, which says that it is not on the map',
      (await selection()) === 'node:platform' &&
        outsideNote !== null &&
        outsideNote.startsWith('Not on the map') &&
        (await countOf('.react-flow__node[data-id="platform"]')) === 0 &&
        (await countOf('.react-flow__node.selected')) === 0,
      { outsideNote, selection: await selection() },
    );
    // Filter is left at once and the whole map follows. In between the filtered map is still on
    // screen, and the panel no longer says that Filter leaves the node out.
    const leavingFilter = await evaluate(`(async () => {
      document.querySelector('#detail-show-on-map').click();
      await window.__smoke.rendered(() => window.__smoke.attr('data-focus-mode') === 'focus');
      return {
        mode: window.__smoke.attr('data-focus-mode'),
        filtered: window.__smoke.attr('data-filtered'),
        notes: window.__smoke.count('#detail-outside-note'),
      };
    })()`);
    check(
      'the note that the selected node is not on the map goes when Filter is left, before the whole map has arrived',
      leavingFilter.mode === 'focus' &&
        leavingFilter.filtered === flowFocus &&
        leavingFilter.notes === 0,
      leavingFilter,
    );
    await until(`window.__smoke.attr('data-focus-mode') === 'focus'`, 'Focus mode again');
    await untilFiltered(null);
    await until(
      `window.__smoke.count('.react-flow__node.selected[data-id="platform"]') === 1`,
      'the node on the whole map',
    );
    await settled();
    check(
      '"Show it" brings the whole map back with the node on it, and the focus bar says that Filter was switched off',
      (await selection()) === 'node:platform' &&
        (await countOf('#detail-outside-note')) === 0 &&
        (await attr('data-focus')) === flowFocus &&
        (await evaluate(`window.__smoke.onScreen('.react-flow__node[data-id="platform"]')`)) ===
          true &&
        (await text('#focus-bar-note')) === 'Filter switched off to show Platform Services.',
      { note: await text('#focus-bar-note'), view: await viewNow() },
    );
    // Another focus while filtering is another map, fitted in turn.
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await click('#focus-bar-mode');
    await untilFiltered(flowFocus);
    const noteAfterSwitch = await countOf('#focus-bar-note');
    await chooseOption('#focus-select', 'flow:rule-release');
    await untilFiltered('flow:rule-release');
    const ruleRelease = {
      nodes: await attr('data-drawn-nodes'),
      bands: await countOf('.arch-band-even, .arch-band-odd'),
      ...(await fitOnScreen()),
    };
    await chooseOption('#focus-select', 'flow:campaign-run');
    await untilFiltered('flow:campaign-run');
    const campaignRun = { nodes: await attr('data-drawn-nodes'), ...(await fitOnScreen()) };
    check(
      'another focus while filtering is another map, fitted in turn: 7 nodes in two rows, then 11 nodes',
      noteAfterSwitch === 0 &&
        ruleRelease.nodes === '7' &&
        ruleRelease.bands === 2 &&
        ruleRelease.fitted &&
        campaignRun.nodes === '11' &&
        campaignRun.fitted,
      { noteAfterSwitch, ruleRelease, campaignRun },
    );
    // An epic: its nodes keep the rows they have on the whole map, the one placed by its
    // connections too.
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    const epicFocus = 'workitem:1001';
    await chooseOption('#focus-select', epicFocus);
    await untilFiltered(epicFocus);
    const epic = {
      nodes: await attr('data-drawn-nodes'),
      placed: await countOf(placedMark),
      bands: await countOf('.arch-band-even, .arch-band-odd'),
      unassigned: await countOf('.arch-band-unassigned'),
    };
    check(
      'filtered to an epic the map keeps its three rows, and the node placed by its connections its mark',
      placedOnWhole === 1 &&
        epic.nodes === '23' &&
        epic.placed === 1 &&
        epic.bands === 3 &&
        epic.unassigned === 0,
      { placedOnWhole, ...epic },
    );
    // This map fills the canvas down to the corner the minimap takes: it is fitted with room
    // for the minimap, on arrival as by Fit view, and none of its boxes lies under it.
    const epicFit = await fitOnScreen();
    const epicCorner = await evaluate(`window.__smoke.underMinimap()`);
    check(
      'a filtered map that reaches the corner of the minimap is fitted clear of it: no box lies under the minimap',
      epicFit.fitted && epicCorner.under.length === 0 && epicCorner.clear,
      { ...epicFit, ...epicCorner },
    );
    // Navigation wins: the search lists the whole model, and going to what the filtered map
    // leaves out shows the whole map again, with the focus kept.
    await openSearch();
    await client.send('Input.insertText', { text: 'platform' });
    await until(
      `window.__smoke.count('#search-results [data-node-id="platform"]') === 1`,
      'the domain among the search results',
    );
    // The mark is a note of its own on the line of the ID, at full strength: the line of the
    // name keeps its width, and the level beside the name says the level alone. On the
    // highlighted match, the one Enter takes, the level and the ID are at full strength too.
    const leftOut = await evaluate(`(() => {
      const option = document.querySelector('#search-results [role="option"]');
      const note = option.querySelector('.search-option-note');
      const top = (selector) => Math.round(option.querySelector(selector).getBoundingClientRect().top);
      return {
        id: option.dataset.nodeId ?? null,
        outside: option.dataset.outside ?? null,
        text: option.textContent,
        note: note?.textContent ?? null,
        level: option.querySelector('.search-option-level').textContent,
        noteOpacity: note ? getComputedStyle(note).opacity : null,
        active: option.classList.contains('search-option-active'),
        activeOpacity: ['.search-option-level', '.search-option-id'].map(
          (selector) => getComputedStyle(option.querySelector(selector)).opacity,
        ),
        onIdLine: note !== null && top('.search-option-note') > top('.search-option-name'),
      };
    })()`);
    check(
      'the search marks a node that the filtered map leaves out',
      leftOut.id === 'platform' &&
        leftOut.outside === 'true' &&
        leftOut.text.includes('not on the filtered map') &&
        leftOut.note === 'not on the filtered map' &&
        leftOut.level === 'domain' &&
        leftOut.noteOpacity === '1' &&
        leftOut.active &&
        leftOut.activeOpacity.join(' ') === '1 1' &&
        leftOut.onIdLine,
      leftOut,
    );
    await press('Enter', { keyCode: 13, text: '\r' });
    await until(
      `window.__smoke.attr('data-focus-mode') === 'focus'`,
      'Focus mode after going to the node',
    );
    await untilFiltered(null);
    await untilSelection('node:platform');
    await until(
      `window.__smoke.count('.react-flow__node.selected[data-id="platform"]') === 1`,
      'the found node on the whole map',
    );
    await settled();
    check(
      'going to it switches Filter off and keeps the focus: the node is selected on the whole map, and the focus bar says so',
      (await attr('data-focus')) === epicFocus &&
        (await evaluate(`window.__smoke.onScreen('.react-flow__node[data-id="platform"]')`)) ===
          true &&
        (await text('#focus-bar-note')) === 'Filter switched off to show Platform Services.',
      { focus: await attr('data-focus'), note: await text('#focus-bar-note') },
    );
    // The focus does not involve the node gone to, and pales what it does not involve — but not
    // what is selected: the node shown can be read, with what is drawn inside it.
    const goneTo = await evaluate(`(() => {
      const node = document.querySelector('.react-flow__node.selected[data-id="platform"]');
      const inside = [...document.querySelectorAll('.react-flow__node[data-id^="platform."]')];
      return {
        faded: node.classList.contains('arch-faded'),
        opacity: getComputedStyle(node).opacity,
        inside: inside.length,
        insideFaded: inside.filter((el) => el.classList.contains('arch-faded')).length,
        otherFaded: window.__smoke.count('.react-flow__node.arch-faded'),
      };
    })()`);
    check(
      'the node gone to is not paled by the focus that does not involve it, the rest still is',
      !goneTo.faded && goneTo.opacity === '1' && goneTo.insideFaded === 0 && goneTo.otherFaded > 0,
      goneTo,
    );
    // A focus that involves nothing of the map (a bug tagged to no node) cannot reduce it: the
    // whole map stays, all of it paled, and bar and hint say that — not that nothing is left out.
    await openSearch();
    await client.send('Input.insertText', { text: '1065' });
    await until(
      `window.__smoke.count('#search-results [data-workitem-id="1065"]') === 1`,
      'the untagged bug among the search results',
    );
    await press('Enter', { keyCode: 13, text: '\r' });
    await untilSelection('workitem:1065');
    await click('#detail-panel .detail-focus');
    await until(`window.__smoke.attr('data-focus') === 'workitem:1065'`, 'the focus on the bug');
    await click('#focus-mode');
    await until(`window.__smoke.attr('data-focus-mode') === 'filter'`, 'Filter mode for the bug');
    await until(
      `window.__smoke.text('#focus-mode-hint') !== 'The rest of the map is paled.'`,
      'the hint for a focus that involves nothing',
    );
    const nothingInvolved = {
      bar: await text('#focus-bar'),
      hint: await text('#focus-mode-hint'),
      filtered: await attr('data-filtered'),
      drawn: await attr('data-drawn-nodes'),
      unfaded: (await evaluate(`window.__smoke.nodeIds(':not(.arch-faded)')`)).length,
    };
    await click('#focus-mode');
    await until(`window.__smoke.attr('data-focus-mode') === 'focus'`, 'Focus mode again');
    await chooseOption('#focus-select', epicFocus);
    await until(`window.__smoke.attr('data-focus') === '${epicFocus}'`, 'the focus on the epic');
    check(
      'a focus that involves nothing of the map is said to: the whole map stays, paled, and nothing is called left out',
      nothingInvolved.filtered === null &&
        nothingInvolved.drawn === '45' &&
        nothingInvolved.unfaded === 0 &&
        nothingInvolved.bar.includes('0 nodes') &&
        nothingInvolved.bar.includes('nothing of it is on the map') &&
        !nothingInvolved.bar.includes('nothing to leave out') &&
        nothingInvolved.hint ===
          'The focus involves nothing on the map: the whole map is shown, paled.',
      nothingInvolved,
    );
    // Positions set by hand belong to one arrangement: the filtered map has its own.
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await click('#focus-bar-mode');
    await untilFiltered(epicFocus);
    await click('#unlock-positions');
    await until(`window.__smoke.attr('data-positions-unlocked') === 'true'`, 'unlocked positions');
    // The header of a domain, right of its name.
    const handle = await evaluate(`(() => {
      for (const node of document.querySelectorAll('.react-flow__node-group')) {
        if (node.dataset.id.includes('.')) continue;
        const r = node.getBoundingClientRect();
        const point = { x: r.right - 30, y: r.top + 14 };
        if (node.contains(document.elementFromPoint(point.x, point.y))) return point;
      }
      return null;
    })()`);
    if (handle === null) throw new Error('no domain to drag on the filtered map');
    await drag(handle, { x: handle.x - 60, y: handle.y + 40 });
    await until(
      `window.__smoke.attr('data-moved-count') === '1'`,
      'one node moved by hand on the filtered map',
    );
    await click('#focus-bar-mode');
    await untilFiltered(null);
    const movedOnWhole = await attr('data-moved-count');
    await click('#focus-bar-mode');
    await untilFiltered(epicFocus);
    const movedOnFiltered = await attr('data-moved-count');
    await click('#reset-positions');
    await until(`window.__smoke.attr('data-moved-count') === '0'`, 'the positions reset');
    await click('#unlock-positions');
    await until(`window.__smoke.attr('data-positions-unlocked') === 'false'`, 'locked positions');
    check(
      'a node moved by hand on the filtered map is moved there only: not on the whole map, and again after coming back',
      movedOnWhole === '0' && movedOnFiltered === '1',
      { movedOnWhole, movedOnFiltered },
    );
    // Collapsing, the level of detail and the hidden kinds act on the filtered map as they do
    // on the whole one; none of them lays it out again. The collapsed groups are those of the
    // whole map: the note counts them all.
    const viewEpic = await viewNow();
    const groupsFiltered = await countOf('.react-flow__node-group');
    const domainsOnly = `window.__smoke.nodeIds().every((id) => !id.includes('.'))`;
    await click('#collapse-all');
    await until(
      `window.__smoke.attr('data-collapsed-count') !== '0' && ${domainsOnly}`,
      'closed domains',
    );
    const collapsedFiltered = {
      drawn: (await evaluate(`window.__smoke.nodeIds()`)).length,
      model: await attr('data-drawn-nodes'),
      notes: await countOf('#collapsed-note'),
      note: await text('#collapsed-note'),
    };
    await click('#expand-all');
    await until(
      `window.__smoke.attr('data-collapsed-count') === '0' && window.__smoke.nodeIds().length === 23`,
      'every node of the filtered map again',
    );
    await pinLod('domains');
    const domainsFiltered = (await evaluate(`window.__smoke.nodeIds()`)).length;
    const domainsAlone = await evaluate(domainsOnly);
    await pinLod('subcomponents');
    const edgesFiltered = await countOf('.react-flow__edge');
    const dataflowFiltered = await countOf('.react-flow__edge.arch-edge-dataflow');
    await click('#kind-filters [data-kind="dataflow"]');
    await until(
      `window.__smoke.attr('data-hidden-kinds') === 'dataflow' && window.__smoke.count('.react-flow__edge.arch-edge-dataflow') === 0`,
      'the kind hidden on the filtered map',
    );
    const withoutDataflow = {
      edges: await countOf('.react-flow__edge'),
      nodes: (await evaluate(`window.__smoke.nodeIds()`)).length,
      filtered: await attr('data-filtered'),
    };
    await click('#kind-filters [data-kind="dataflow"]');
    await until(`window.__smoke.attr('data-hidden-kinds') === ''`, 'the kind shown again');
    check(
      'Collapse all, a pinned level and a hidden edge kind act on the filtered map',
      collapsedFiltered.drawn > 0 &&
        collapsedFiltered.drawn < 23 &&
        collapsedFiltered.drawn === domainsFiltered &&
        domainsAlone &&
        collapsedFiltered.model === '23' &&
        groupsFiltered < groupsOnWhole &&
        collapsedFiltered.notes === 1 &&
        collapsedFiltered.note === `${groupsOnWhole} collapsed by hand` &&
        dataflowFiltered > 0 &&
        withoutDataflow.edges === edgesFiltered - dataflowFiltered &&
        withoutDataflow.nodes === 23 &&
        withoutDataflow.filtered === epicFocus &&
        sameView(await viewNow(), viewEpic),
      {
        collapsedFiltered,
        groupsOnWhole,
        groupsFiltered,
        domainsFiltered,
        edgesFiltered,
        dataflowFiltered,
        withoutDataflow,
      },
    );
    // A saved view keeps Filter with the focus, and its place on the filtered map.
    await chooseOption('#focus-select', flowFocus);
    await untilFiltered(flowFocus);
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    const grip = await evaluate(`window.__smoke.emptyPoint()`);
    await drag(grip, { x: grip.x + 120, y: grip.y + 50 });
    await settled();
    const viewSaved = await viewNow();
    /** Saves the map as it is under a name, on the Views tab. @param {string} name */
    const saveView = async (name) => {
      await evaluate(`(() => {
        const input = document.querySelector('#view-name');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(name)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await evaluate(`document.querySelector('#save-view').click()`);
    };
    await saveView('Telemetry alone');
    await until(
      `window.__smoke.count('#views-list li') === 1`,
      'the view saved on the filtered map',
    );
    const savedNote = {
      lists: await countOf('#views-list'),
      notes: await countOf('#views-note'),
      note: await text('#views-note'),
    };
    await click('#focus-clear');
    await until(`window.__smoke.attr('data-focus') === null`, 'the focus cleared');
    await untilFiltered(null);
    await evaluate(`document.querySelector('#views-list .views-apply').click()`);
    await until(
      `window.__smoke.attr('data-focus') === '${flowFocus}' && window.__smoke.attr('data-lines-laid-out') === 'true'`,
      'the focus of the view',
    );
    await settled();
    check(
      'a view saved on a filtered map brings back the focus, Filter and the place',
      savedNote.lists === 1 &&
        savedNote.notes === 1 &&
        savedNote.note === 'Saved "Telemetry alone".' &&
        (await attr('data-filtered')) === flowFocus &&
        (await attr('data-focus-mode')) === 'filter' &&
        sameView(await viewNow(), viewSaved) &&
        // The Views tab says so where it lists what a view keeps.
        (await text('#views')).includes(
          'focus (and Filter, when the map was reduced to the focus)',
        ),
      { savedNote, filtered: await attr('data-filtered'), viewSaved, now: await viewNow() },
    );
    // What a view or a link keeps is the map on screen. Between a change of the focus and the
    // arrival of its map that is still the map before: a link copied then is one of the filtered
    // map, whose place it carries.
    const linkedMeanwhile = await evaluate(`(async () => {
      window.__smoke.choose('#focus-select', '');
      await window.__smoke.rendered(() => window.__smoke.attr('data-focus') === null);
      document.querySelector('#copy-view-link').click();
      return {
        focus: window.__smoke.attr('data-focus'),
        filtered: window.__smoke.attr('data-filtered'),
        hash: window.location.hash,
      };
    })()`);
    const viewMeanwhile = JSON.parse(
      Buffer.from(linkedMeanwhile.hash.slice('#view='.length), 'base64url').toString('utf8'),
    );
    check(
      'a link copied after the focus was cleared, before the whole map has arrived, is one of the filtered map still on screen',
      linkedMeanwhile.focus === null &&
        linkedMeanwhile.filtered === flowFocus &&
        same(viewMeanwhile.focus, { type: 'flow', id: flowFocus.slice('flow:'.length) }) &&
        viewMeanwhile.focusMode === 'filter',
      { focus: linkedMeanwhile.focus, filtered: linkedMeanwhile.filtered, view: viewMeanwhile },
    );
    await untilFiltered(null);
    // The place of a view waits for the map of that view only: the reader's next choice drops
    // it. With the focus cleared before the filtered map of the view has arrived, the whole map
    // stays where it is. (Moved first, so that it is not where a fit would put it.)
    const gripWhole = await evaluate(`window.__smoke.emptyPoint()`);
    await drag(gripWhole, { x: gripWhole.x + 90, y: gripWhole.y + 60 });
    await settled();
    const viewKept = await viewNow();
    await until(viewIsStored, 'the moved view of the whole map stored');
    const storedKept = await evaluate(`window.__smoke.storedViewport()`);
    const overtaken = await evaluate(`(async () => {
      document.querySelector('#views-list .views-apply').click();
      await window.__smoke.rendered(() => window.__smoke.attr('data-focus') !== null);
      const applied = {
        focus: window.__smoke.attr('data-focus'),
        pending: window.__smoke.attr('data-layout-pending'),
      };
      window.__smoke.choose('#focus-select', '');
      await window.__smoke.rendered(() => window.__smoke.attr('data-focus') === null);
      return { applied, focus: window.__smoke.attr('data-focus') };
    })()`);
    await untilFiltered(null);
    await sleep(600); // a view that is fitted, and then stored, would be by now
    check(
      'the focus cleared before the map of an applied view has arrived: the whole map stays where it was, and so does its stored viewport',
      overtaken.applied.focus === flowFocus &&
        overtaken.applied.pending === 'true' &&
        overtaken.focus === null &&
        sameView(await viewNow(), viewKept) &&
        (await evaluate(`window.__smoke.storedViewport()`)) === storedKept,
      { overtaken, viewKept, now: await viewNow() },
    );
    // Likewise a view of the whole map applied on a filtered one, with another focus chosen
    // before the whole map has arrived: the map of that focus arrives fitted, like any.
    await saveView('Whole map');
    await until(`window.__smoke.count('#views-list li') === 2`, 'the view of the whole map saved');
    await chooseOption('#focus-select', flowFocus);
    await untilFiltered(flowFocus);
    await evaluate(`(async () => {
      document.querySelector('#views-list li[data-view-name="Whole map"] .views-apply').click();
      await window.__smoke.rendered(() => window.__smoke.attr('data-focus') === null);
      window.__smoke.choose('#focus-select', 'flow:rule-release');
    })()`);
    await untilFiltered('flow:rule-release');
    const fitOvertaken = await fitOnScreen();
    check(
      'another focus chosen before the whole map of an applied view has arrived: its map is fitted, not put at the place of the view',
      fitOvertaken.fitted,
      fitOvertaken,
    );
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await evaluate(
      `document.querySelector('#views-list li[data-view-name="Whole map"] .views-delete').click()`,
    );
    await until(
      `window.__smoke.count('#views-list li') === 1`,
      'the view of the whole map deleted',
    );
    // Back on the filtered map of the first view, where the link below is made.
    await evaluate(`document.querySelector('#views-list .views-apply').click()`);
    await untilFiltered(flowFocus);
    await evaluate(`document.querySelector('#views-list .views-delete').click()`);
    await until(`window.__smoke.count('#views-list li') === 0`, 'the view deleted');
    // A link made on a filtered map carries Filter too.
    await evaluate(`document.querySelector('#copy-view-link').click()`);
    await until(`window.location.hash.startsWith('#view=')`, 'the link in the address bar');
    /** @type {string} */
    const filteredHash = await evaluate(`window.location.hash`);
    await reloadWith(filteredHash);
    await until(
      `window.__smoke.attr('data-focus') === '${flowFocus}' && window.__smoke.attr('data-lines-laid-out') === 'true'`,
      'the focus of the link',
    );
    await settled();
    check(
      'a link copied on a filtered map opens the map filtered, at the same place',
      (await attr('data-filtered')) === flowFocus &&
        (await attr('data-focus-mode')) === 'filter' &&
        (await attr('data-drawn-nodes')) === '14' &&
        sameView(await viewNow(), viewSaved),
      { filtered: await attr('data-filtered'), viewSaved, now: await viewNow() },
    );
    const linkedView = JSON.parse(
      Buffer.from(filteredHash.slice('#view='.length), 'base64url').toString('utf8'),
    );
    const linkOf = (/** @type {object} */ view) =>
      `#view=${Buffer.from(JSON.stringify(view)).toString('base64url')}`;
    // The same link opened where the structure does not have the flow: its place is one of a
    // map that cannot be shown, so the whole map is fitted instead of being put there. (The
    // pinned level of the link says that the link has been applied.)
    await reloadWith(linkOf({ ...linkedView, focus: { type: 'flow', id: 'no-such-flow' } }));
    await until(
      `window.__smoke.attr('data-lod-mode') === ${JSON.stringify(linkedView.lodMode)}`,
      'the level of the link without its flow',
    );
    await sleep(300); // the view of the link follows its level
    const fitWithoutFlow = await fitOnScreen();
    check(
      'a link made on a filtered map, opened where its flow is gone, shows the whole map fitted',
      linkedView.lodMode === 'subcomponents' &&
        (await attr('data-focus')) === null &&
        (await attr('data-filtered')) === null &&
        (await attr('data-drawn-nodes')) === '45' &&
        fitWithoutFlow.fitted,
      { lodMode: linkedView.lodMode, ...fitWithoutFlow },
    );
    // A link without the mode was made on the whole map: it opens with the rest paled, although
    // the switch was left on.
    const { focusMode: linkedMode, ...viewWithoutMode } = linkedView;
    const switchStored = await evaluate(
      `JSON.parse(localStorage.getItem('architecture-map.settings') ?? '{}').focusMode ?? null`,
    );
    await reloadWith(linkOf(viewWithoutMode));
    await until(
      `window.__smoke.attr('data-focus') === '${flowFocus}' && window.__smoke.attr('data-lines-laid-out') === 'true'`,
      'the focus of the link without the mode',
    );
    await settled();
    check(
      'a link without the mode opens in Focus mode although the switch was on',
      linkedMode === 'filter' &&
        switchStored === 'filter' &&
        (await attr('data-focus-mode')) === 'focus' &&
        (await attr('data-filtered')) === null &&
        (await countOf('.react-flow__node.arch-faded')) > 0,
      { linkedMode, switchStored, mode: await attr('data-focus-mode') },
    );
    // The focus is not remembered, the switch is: a plain reload shows the whole map where it
    // was, with Filter waiting for a focus.
    await until(viewIsStored, 'the view of the whole map stored');
    const viewWhole = await viewNow();
    await click('#focus-mode');
    await untilFiltered(flowFocus);
    await sleep(600); // the view of the filtered map would be stored by now, if it were
    await reloadWith('');
    await settled();
    check(
      'a reload without a link keeps the switch and drops the focus: the whole map, in the view it had before',
      (await attr('data-focus-mode')) === 'filter' &&
        (await attr('data-focus')) === null &&
        (await attr('data-filtered')) === null &&
        (await attr('data-drawn-nodes')) === '45' &&
        (await text('#focus-mode-hint')).includes('Applies once a focus is chosen') &&
        sameView(await viewNow(), viewWhole),
      { mode: await attr('data-focus-mode'), viewWhole, now: await viewNow() },
    );
    // So do the files read again while the map is filtered: they are another model, whose map
    // is the whole one.
    await chooseOption('#focus-select', flowFocus);
    await untilFiltered(flowFocus);
    await click('#reload-files');
    await until(
      `window.__smoke.attr('data-focus') === null && window.__smoke.attr('data-lines-laid-out') === 'true' && window.__smoke.count('.react-flow__node') > 0`,
      'the map of the files read again',
    );
    await settled();
    check(
      'Reload on a filtered map shows the whole map again, in the view it had, with the switch still on',
      (await attr('data-focus-mode')) === 'filter' &&
        (await attr('data-filtered')) === null &&
        (await attr('data-drawn-nodes')) === '45' &&
        (await countOf('#focus-bar')) === 0 &&
        sameView(await viewNow(), viewWhole),
      { mode: await attr('data-focus-mode'), viewWhole, now: await viewNow() },
    );
    // In Auto at the Everything level the filtered map arrives with its lists and is fitted,
    // which takes the zoom out of that level: the map laid out again without the lists is
    // fitted once more.
    await pinLod('auto', await attr('data-zoom-lod'));
    const middle = await evaluate(`(() => {
      const r = document.querySelector('.react-flow').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    for (let turn = 0; turn < 8 && (await attr('data-zoom-lod')) !== 'detail'; turn++) {
      const { zoom } = await viewNow();
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        ...middle,
        deltaX: 0,
        deltaY: -300,
      });
      await until(`window.__smoke.viewport().zoom > ${zoom}`, 'the zoom after a wheel turn');
      await settled();
    }
    await until(
      `window.__smoke.attr('data-lod') === 'detail' && window.__smoke.attr('data-lines-laid-out') === 'true'`,
      'the Everything level by zoom, with its lists',
    );
    const linesBefore = await countOf('.arch-workitem');
    await chooseOption('#focus-select', flowFocus);
    await until(
      `window.__smoke.attr('data-filtered') === '${flowFocus}' && window.__smoke.attr('data-lod') !== 'detail' && window.__smoke.attr('data-lines-laid-out') === 'true'`,
      'the filtered map below the Everything level, laid out without the lists',
    );
    const linesAfter = await countOf('.arch-workitem');
    const fitWithoutLists = await fitOnScreen();
    check(
      'entering Filter at the Everything level in Auto: the map laid out again without the lists is fitted again',
      linesBefore > 0 && linesAfter === 0 && fitWithoutLists.fitted,
      { linesBefore, linesAfter, ...fitWithoutLists },
    );
    // Back to what the checks below start from: nothing focused, the rest paled when something
    // is, and the whole map in view with closed component boxes.
    await click('#focus-clear');
    await until(`window.__smoke.attr('data-focus') === null`, 'the focus cleared at the end');
    await click('#focus-mode');
    await until(`window.__smoke.attr('data-focus-mode') === 'focus'`, 'Focus mode at the end');
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await pinLod('components');
    await click('#fit-view');
    await settled();
    if ((await attr('data-panel-tab')) !== tabBeforeFilter) {
      await click(`#tab-${tabBeforeFilter}`);
      await until(
        `window.__smoke.attr('data-panel-tab') === '${tabBeforeFilter}'`,
        'the tab shown before',
      );
    }

    // Heat and progress on the boxes.
    await setSetting('heat', true);
    await until(`window.__smoke.count('.arch-heat') > 0`, 'the heat strips');
    const heat = await evaluate(`(() => {
      const strips = [...document.querySelectorAll('.arch-heat-left')];
      return strips.map((strip) => {
        const node = strip.closest('.react-flow__node');
        const box = strip.getBoundingClientRect();
        const outer = node.getBoundingClientRect();
        return { id: node.dataset.id, open: Number(strip.dataset.heat), ratio: box.height / outer.height, inside: box.bottom <= outer.bottom + 2 && box.top >= outer.top - 2 };
      });
    })()`);
    check(
      'heat strips stand on the bottom of their boxes, as tall as the open work left in them',
      heat.length > 0 &&
        heat.every(
          (/** @type {any} */ h) => h.inside && h.open > 0 && h.ratio > 0.05 && h.ratio <= 1.01,
        ) &&
        heat.some((/** @type {any} */ h) => h.ratio > 0.9) &&
        heat.some((/** @type {any} */ h) => h.ratio < 0.5),
      heat.slice(0, 6),
    );
    await setSetting('progress', true);
    await until(`window.__smoke.count('.arch-progress') > 0`, 'the progress bars');
    const progress = await evaluate(`(() => {
      const bars = [...document.querySelectorAll('.arch-progress')];
      return bars.map((bar) => ({ id: bar.closest('.react-flow__node').dataset.id, done: Number(bar.dataset.done), total: Number(bar.dataset.total), title: bar.title }));
    })()`);
    check(
      'progress bars count the completed items over all items of the box',
      progress.length > 0 &&
        progress.every(
          (/** @type {any} */ p) => p.total > 0 && p.done <= p.total && p.title.includes('done'),
        ) &&
        progress.some((/** @type {any} */ p) => p.done > 0 && p.done < p.total),
      progress.slice(0, 6),
    );
    await click('.react-flow__node[data-id="data.event-store"]');
    await untilSelection('node:data.event-store');
    check(
      'the node panel states the inherited attributes, the metrics, the work and the flows',
      (await text('#detail-panel [data-attribute="owner"]')) === 'Data team' &&
        (await text('#detail-panel .detail-inherited')).includes('from Data Platform') &&
        (await text('#detail-work')).includes('done') &&
        (await countOf('#detail-flows [data-flow-id="telemetry-to-dashboards"]')) === 1,
    );
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await click('#fit-view');
    await sleep(600);
    await click('.react-flow__node[data-id="backoffice.studio"]');
    await untilSelection('node:backoffice.studio');
    check(
      'the node panel lists metrics and links',
      (await text('#detail-panel [data-metric="loc"]')) === '184000' &&
        (await countOf('#detail-links a[href^="https://"]')) === 2,
    );
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await setSetting('heat', false);
    await setSetting('progress', false);
    await sleep(200);
    check(
      'heat and progress switch off again',
      (await countOf('.arch-heat')) === 0 && (await countOf('.arch-progress')) === 0,
    );
    // Colour by an attribute and by a metric.
    await chooseOption('#color-by', 'owner');
    await until(`window.__smoke.attr('data-color-by') === 'owner'`, 'colour by owner');
    const legend = await evaluate(
      `[...document.querySelectorAll('#color-legend [data-legend-value]')].map((e) => e.dataset.legendValue)`,
    );
    check(
      'colour by an attribute tints the boxes and shows one legend entry per value',
      legend.length === 4 &&
        legend[0] === 'Tooling team' &&
        (await countOf('.arch-tinted')) > 0 &&
        (await countOf('.react-flow__node[data-id="data.event-store"] .arch-tinted')) === 1,
      legend,
    );
    await chooseOption('#color-by', 'metric:churn');
    await until(`window.__smoke.attr('data-color-by') === 'metric:churn'`, 'colour by churn');
    check(
      'colour by a metric shows the range of the ramp and tints only the nodes that have it',
      (await text('#color-legend')).includes('73') &&
        (await countOf('#color-legend .color-legend-gradient')) === 1 &&
        (await countOf('.react-flow__node[data-id="data.event-store"] .arch-tinted')) === 0 &&
        (await countOf('.react-flow__node[data-id="backoffice.studio"] .arch-tinted')) === 1,
    );
    await chooseOption('#color-by', 'none');
    await until(`window.__smoke.attr('data-color-by') === 'none'`, 'colour by nothing');
    check('colour by nothing tints nothing', (await countOf('.arch-tinted')) === 0);

    // --- Labels and presets: the list, the legend, the boxes, the panel, views and links -------
    // The example gives `exposure` to four domains and one component (staff, public, partner,
    // internal; Platform Services and what is in it have none) and has two presets: Exposure, on
    // that label, and Lifecycle, on the status.
    /**
     * The legend of Colour by as the page states it, with what stands under the list of choices.
     * @typedef {object} ColourLegend
     * @property {string | null} colorBy
     * @property {string | null} title
     * @property {string | null} tooltip the description, on the title
     * @property {string[]} subtitles
     * @property {string[]} values the values and "Other", in the order shown
     * @property {string[]} kinds
     * @property {number[]} counts
     * @property {number[]} none the count of "No value", when it is listed
     * @property {string | null} lastTitle the tooltip of the last entry
     * @property {string | null} note the description under the list
     * @property {string | null} describedBy what the list says describes it
     */
    const LABELS_VIEW = 'Before the labels';
    const labelsStart = {
      tab: await attr('data-panel-tab'),
      hash: await evaluate(`window.location.hash`),
      focusMode: await attr('data-focus-mode'),
      heat: (await attr('data-heat')) === 'true',
      lodMode: await attr('data-lod-mode'),
      collapsed: await attr('data-collapsed-count'),
      colorBy: await attr('data-color-by'),
    };
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    // The level, the closed groups, the place and the colouring come back with this view.
    await saveView(LABELS_VIEW);
    await until(
      `window.__smoke.count('#views-list li[data-view-name="${LABELS_VIEW}"]') === 1`,
      'the view to come back to',
    );
    // No link in the address: the one copied below is then the only one.
    await evaluate(`window.history.replaceState(null, '', window.location.href.split('#')[0])`);
    /**
     * Chooses under Colour by. Whether the map then says that it is coloured so: false when it
     * does not in time.
     * @param {string} value
     */
    const colourBy = async (value) => {
      await chooseOption('#color-by', value);
      return eventually(
        `window.__smoke.attr('data-color-by') === ${JSON.stringify(value)}`,
        `colour by ${value}`,
      );
    };
    /** @returns {Promise<ColourLegend | null>} */
    const colourLegend = () =>
      evaluate(`(() => {
        const legend = document.querySelector('#color-legend');
        if (!legend) return null;
        const title = legend.querySelector('.color-legend-title');
        const entries = [...legend.querySelectorAll('li[data-legend-value]')];
        return {
          colorBy: legend.getAttribute('data-color-by'),
          title: title?.textContent ?? null,
          tooltip: title?.getAttribute('title') ?? null,
          subtitles: [...legend.querySelectorAll('.color-legend-subtitle')].map((e) => e.textContent),
          values: entries.map((e) => e.dataset.legendValue),
          kinds: entries.map((e) => e.dataset.legendKind),
          counts: entries.map((e) => Number(e.dataset.legendCount)),
          none: [...legend.querySelectorAll('li[data-legend-kind="none"]')].map((e) => Number(e.dataset.legendCount)),
          lastTitle: entries.at(-1)?.getAttribute('title') ?? null,
          note: document.querySelector('#color-by-note')?.textContent ?? null,
          describedBy: document.querySelector('#color-by')?.getAttribute('aria-describedby') ?? null,
        };
      })()`);
    /**
     * The light colour of every tinted box drawn, by the ID of its node.
     * @returns {Promise<Record<string, string>>}
     */
    const boxTints = () =>
      evaluate(`Object.fromEntries(
        [...document.querySelectorAll('.react-flow__node .arch-tinted')]
          .map((box) => [box.closest('.react-flow__node').dataset.id, getComputedStyle(box).getPropertyValue('--tint-light').trim()])
          .sort(([a], [b]) => (a < b ? -1 : 1)),
      )`);
    /** The background of the chip of a value in the legend. @param {string} value */
    const chipColour = (value) =>
      evaluate(`(() => {
        const chip = document.querySelector(${JSON.stringify(`#color-legend li[data-legend-value="${value}"] .color-legend-chip`)});
        return chip ? getComputedStyle(chip).backgroundColor : null;
      })()`);
    /** The sum of the counts of a legend. @param {readonly number[]} counts */
    const boxesOf = (counts) => counts.reduce((sum, count) => sum + count, 0);
    /**
     * The light colour the preset Exposure gives a node of the example: the colours of the file
     * for public, partner and staff, and the first free one of the palette for internal.
     * @param {string} id
     */
    const exposureColour = (id) => {
      if (id === 'storefront.payment') return '#8e44ad';
      const domain = id.split('.')[0];
      if (domain === 'storefront') return '#e34948';
      if (domain === 'backoffice' || domain === 'operations') return '#0d6b5e';
      return domain === 'data' ? '#2a78d6' : undefined;
    };
    /**
     * Closes or opens a group with a click on its chevron; nothing to do for one that is so
     * already. A chevron that cannot be clicked where it is — off the canvas, or under a legend —
     * is brought there: the map is fitted, and the group moved towards the middle of the canvas.
     * @param {string} id @param {boolean} closed
     */
    const setClosed = async (id, closed) => {
      const box = `.react-flow__node[data-id="${id}"]`;
      const chevron = JSON.stringify(`${box} .arch-chevron`);
      const free = async () => (await evaluate(`window.__smoke.clickPoint(${chevron})`)) !== null;
      await settled();
      if ((await countOf(`${box} [data-collapsed="${closed}"]`)) === 1) return;
      if (!(await free())) {
        await click('#fit-view');
        await settled();
      }
      for (let turn = 0; turn < 3; turn++) {
        if (await free()) break;
        const offset = await evaluate(`window.__smoke.centreOffset(${JSON.stringify(box)})`);
        if (offset === null) break;
        const plan = await evaluate(`window.__smoke.panPlan(${-offset.dx}, ${-offset.dy})`);
        if (plan === null) break;
        await drag(plan.from, plan.to);
        await settled();
      }
      await click(`${box} .arch-chevron`);
      await until(
        `window.__smoke.count(${JSON.stringify(`${box} [data-collapsed="${closed}"]`)}) === 1 && window.__smoke.attr('data-lines-laid-out') === 'true'`,
        `${id} ${closed ? 'closed' : 'open'}`,
      );
      await settled();
    };
    /** Goes to a node by its ID in the search box, which selects it. @param {string} id */
    const selectById = async (id) => {
      await openSearch();
      await client.send('Input.insertText', { text: id });
      await until(
        `document.querySelector('#search-results [role="option"]')?.dataset.nodeId === ${JSON.stringify(id)}`,
        `${id} first among the search results`,
      );
      await press('Enter', { keyCode: 13, text: '\r' });
      await untilSelection(`node:${id}`);
      await settled();
    };

    const colourChoices = await evaluate(`(() => {
      const values = (parent) => [...parent.querySelectorAll('option')].map((option) => option.value);
      const list = document.querySelector('#color-by');
      return {
        groups: [...list.querySelectorAll('optgroup')].map((group) => group.label),
        grouped: [...list.querySelectorAll('optgroup')].map((group) => values(group).join(' ')),
        values: values(list),
        texts: [...list.querySelectorAll('option')].map((option) => option.textContent),
      };
    })()`);
    check(
      'Colour by groups its choices',
      same(colourChoices.groups, ['Presets', 'Labels', 'Metrics']) &&
        same(colourChoices.values, [
          'none',
          'preset:Exposure',
          'preset:Lifecycle',
          'owner',
          'status',
          'tech',
          'label:exposure',
          'metric:loc',
          'metric:churn',
        ]) &&
        same(colourChoices.grouped, [
          'preset:Exposure preset:Lifecycle',
          'owner status tech label:exposure',
          'metric:loc metric:churn',
        ]) &&
        same(colourChoices.texts.slice(0, 7), [
          'Nothing',
          'Exposure',
          'Lifecycle',
          'Owner',
          'Status',
          'Tech',
          'exposure',
        ]),
      colourChoices,
    );

    // At a level that draws every box, with every group open: the canvas keeps every node in
    // the page, in view or not.
    await pinLod('subcomponents');
    if ((await attr('data-collapsed-count')) !== '0') {
      await click('#expand-all');
      await until(`window.__smoke.attr('data-collapsed-count') === '0'`, 'everything expanded');
    }
    await until(`window.__smoke.nodeIds().length === 45`, 'every box of the example');
    const exposureChosen = await colourBy('preset:Exposure');
    const exposure = await colourLegend();
    check(
      'a preset colours by its label, in its order, with its counts',
      exposureChosen &&
        exposure !== null &&
        exposure.colorBy === 'preset:Exposure' &&
        exposure.title === 'Exposure' &&
        exposure.tooltip === 'Who can reach each part of the shop' &&
        same(exposure.subtitles, ['by exposure']) &&
        exposure.note === 'Who can reach each part of the shop' &&
        exposure.describedBy === 'color-by-note' &&
        // The file writes staff first: a legend in the order of the file fails here.
        same(exposure.values, ['public', 'partner', 'staff', 'internal']) &&
        same(exposure.kinds, ['value', 'value', 'value', 'value']) &&
        same(exposure.counts, [13, 1, 18, 9]) &&
        same(exposure.none, [4]),
      exposure,
    );
    const exposureTints = await boxTints();
    const partnerChip = await chipColour('partner');
    const tintsOff = Object.entries(exposureTints)
      .filter(([id, tint]) => tint !== exposureColour(id))
      .map(([id, tint]) => `${id} ${tint}`);
    check(
      'a colour of the file reaches the box',
      exposureTints['storefront.payment'] === '#8e44ad' &&
        exposureTints['storefront.gateway'] === '#e34948' &&
        (await countOf('.react-flow__node[data-id="platform"]')) === 1 &&
        (await countOf('.react-flow__node[data-id="platform"] .arch-tinted')) === 0 &&
        tintsOff.length === 0 &&
        partnerChip === 'rgb(142, 68, 173)',
      { payment: exposureTints['storefront.payment'], tintsOff, partnerChip },
    );
    const tintedBoxes = await countOf('.arch-tinted');
    const drawnForCounts = {
      lodMode: await attr('data-lod-mode'),
      collapsed: await attr('data-collapsed-count'),
      nodes: await attr('data-drawn-nodes'),
      bands: await countOf('.react-flow__node-band .arch-tinted'),
    };
    check(
      'the counts are the boxes',
      exposure !== null &&
        ['subcomponents', 'detail'].includes(drawnForCounts.lodMode) &&
        drawnForCounts.collapsed === '0' &&
        drawnForCounts.nodes === '45' &&
        drawnForCounts.bands === 0 &&
        tintedBoxes === 41 &&
        tintedBoxes === boxesOf(exposure.counts) &&
        tintedBoxes === 45 - boxesOf(exposure.none),
      { tintedBoxes, ...drawnForCounts, counts: exposure?.counts, none: exposure?.none },
    );

    // The colour of each scheme, where the file gives two: the scheme is set, light and then
    // dark, since a headless browser may take the one of the machine it runs on.
    const darkAtStart = await evaluate(`window.matchMedia('(prefers-color-scheme: dark)').matches`);
    /** @param {'light' | 'dark' | null} scheme null: the scheme of the browser again */
    const emulateScheme = async (scheme) => {
      await client.send('Emulation.setEmulatedMedia', {
        features: scheme === null ? [] : [{ name: 'prefers-color-scheme', value: scheme }],
      });
      await until(
        `window.matchMedia('(prefers-color-scheme: dark)').matches === ${scheme === null ? darkAtStart : scheme === 'dark'}`,
        scheme === null ? 'the scheme of the browser' : `the ${scheme} scheme`,
      );
    };
    // The chip of "staff", the stripe of a box that has the value, and the colour of the names:
    // the kinds of box (group or leaf, its level, closed or not) that have tinted and untinted
    // boxes, and those of them whose names differ in colour.
    const schemeColours = () =>
      evaluate(`(() => {
        const chip = document.querySelector('#color-legend li[data-legend-value="staff"] .color-legend-chip');
        const box = document.querySelector('.react-flow__node[data-id="backoffice"] .arch-tinted');
        const kinds = new Map();
        for (const node of document.querySelectorAll('.react-flow__node .arch-node')) {
          const name = node.querySelector('.arch-node-name');
          if (!name) continue;
          const kind = [...node.classList].filter((c) => c !== 'arch-tinted').sort().join(' ');
          const seen = kinds.get(kind) ?? { tinted: new Set(), plain: new Set() };
          (node.classList.contains('arch-tinted') ? seen.tinted : seen.plain).add(getComputedStyle(name).color);
          kinds.set(kind, seen);
        }
        const both = [...kinds].filter(([, seen]) => seen.tinted.size > 0 && seen.plain.size > 0);
        return {
          chip: chip ? getComputedStyle(chip).backgroundColor : null,
          stripe: box ? getComputedStyle(box, '::before').backgroundColor : null,
          namesCompared: both.length,
          namesOff: both
            .filter(([, seen]) => seen.tinted.size !== 1 || seen.plain.size !== 1 || [...seen.tinted][0] !== [...seen.plain][0])
            .map(([kind]) => kind),
        };
      })()`);
    await emulateScheme('light');
    const inLight = await schemeColours();
    await emulateScheme('dark');
    const inDark = await schemeColours();
    await emulateScheme(null);
    check(
      'the dark scheme has the dark colour, in the legend as on the box',
      inLight.chip === 'rgb(13, 107, 94)' &&
        inLight.stripe === inLight.chip &&
        inDark.chip === 'rgb(95, 209, 191)' &&
        inDark.stripe === inDark.chip &&
        inLight.namesCompared > 0 &&
        inLight.namesOff.length === 0 &&
        inDark.namesCompared > 0 &&
        inDark.namesOff.length === 0,
      { inLight, inDark },
    );

    // Heat by work and a focus draw over the colour and pale it; they do not take it away.
    await setSetting('heat', true);
    const heatOnTint = await eventually(
      `window.__smoke.count('.arch-tinted .arch-heat') > 0`,
      'heat strips on a tinted box',
    );
    const tintsWithHeat = await boxTints();
    if ((await attr('data-focus-mode')) !== 'focus') {
      await click('#focus-mode');
      await until(`window.__smoke.attr('data-focus-mode') === 'focus'`, 'Focus mode');
    }
    await chooseOption('#focus-select', 'flow:telemetry-to-dashboards');
    await until(
      `window.__smoke.attr('data-focus') === 'flow:telemetry-to-dashboards'`,
      'the focus on the flow',
    );
    await untilSelection('flow:telemetry-to-dashboards');
    await settled();
    const fadedTints = await evaluate(
      `[...document.querySelectorAll('.react-flow__node.arch-faded .arch-tinted')].map((box) => [box.closest('.react-flow__node').dataset.id, getComputedStyle(box).getPropertyValue('--tint-light').trim()])`,
    );
    const tintsWithFocus = await boxTints();
    check(
      'Focus and heat leave the colour where it is',
      Object.keys(exposureTints).length === 41 &&
        heatOnTint &&
        same(tintsWithHeat, exposureTints) &&
        fadedTints.length > 0 &&
        fadedTints.every(
          (/** @type {[string, string]} */ [id, tint]) => tint === exposureColour(id),
        ) &&
        same(tintsWithFocus, exposureTints),
      {
        heatOnTint,
        heated: Object.keys(tintsWithHeat).length,
        focused: Object.keys(tintsWithFocus).length,
        faded: fadedTints.slice(0, 6),
      },
    );
    await click('#focus-clear');
    await until(`window.__smoke.attr('data-focus') === null`, 'the focus cleared');
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await setSetting('heat', labelsStart.heat);
    await until(
      `(window.__smoke.count('.arch-heat') > 0) === ${labelsStart.heat}`,
      'the heat as it was',
    );
    if ((await attr('data-focus-mode')) !== labelsStart.focusMode) {
      await click('#focus-mode');
      await until(
        `window.__smoke.attr('data-focus-mode') === '${labelsStart.focusMode}'`,
        'the Focus / Filter switch as it was',
      );
    }

    // The label itself: the colours of the palette, in the order the values come in the file.
    const labelChosen = await colourBy('label:exposure');
    const byLabel = await colourLegend();
    const paymentByLabel = (await boxTints())['storefront.payment'];
    check(
      'a label colours with the palette, in the order of the file',
      labelChosen &&
        byLabel !== null &&
        byLabel.colorBy === 'label:exposure' &&
        byLabel.title === 'exposure' &&
        byLabel.tooltip === null &&
        byLabel.subtitles.length === 0 &&
        byLabel.note === null &&
        byLabel.describedBy === null &&
        same(byLabel.values, ['staff', 'public', 'partner', 'internal']) &&
        same(byLabel.counts, [18, 13, 1, 9]) &&
        same(byLabel.none, [4]) &&
        paymentByLabel === '#1baf7a',
      { byLabel, paymentByLabel },
    );
    const ownerChosen = await colourBy('owner');
    const byOwner = await colourLegend();
    const techChosen = await colourBy('tech');
    const byTech = await colourLegend();
    check(
      'the legend of an attribute counts too',
      ownerChosen &&
        byOwner !== null &&
        same(byOwner.values, ['Tooling team', 'Shop IT', 'Web team', 'Data team']) &&
        same(byOwner.counts, [9, 13, 14, 9]) &&
        byOwner.none.length === 0 &&
        techChosen &&
        byTech !== null &&
        byTech.values.length === 7 &&
        boxesOf(byTech.counts) === 36 &&
        same(byTech.none, [9]),
      { byOwner, byTech },
    );

    // The detail panel of a node: its labels after Owner / Status / Tech and before the metrics,
    // with the node a value comes from when that is another.
    const labelFields = () =>
      evaluate(`(() => {
        const before = (a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        const panel = document.querySelector('#detail-panel');
        return [...panel.querySelectorAll('[data-label]')].map((value) => ({
          label: value.dataset.label,
          name: value.parentElement.previousElementSibling?.textContent ?? null,
          value: value.textContent,
          field: value.parentElement.textContent,
          placed:
            [...panel.querySelectorAll('[data-attribute]')].every((other) => before(other, value)) &&
            [...panel.querySelectorAll('[data-metric]')].every((other) => before(value, other)),
        }));
      })()`);
    await selectById('storefront.gateway.api');
    const labelsInherited = await labelFields();
    await selectById('storefront.payment');
    const labelsOwn = await labelFields();
    await selectById('platform.logging');
    const labelsNone = {
      fields: await labelFields(),
      owner: await text('#detail-panel [data-attribute="owner"]'),
    };
    check(
      'the detail panel lists the labels that hold',
      labelsInherited.length === 1 &&
        labelsInherited[0].label === 'exposure' &&
        labelsInherited[0].name === 'exposure' &&
        labelsInherited[0].value === 'public' &&
        labelsInherited[0].field.includes('(from Storefront)') &&
        labelsInherited[0].placed &&
        labelsOwn.length === 1 &&
        labelsOwn[0].value === 'partner' &&
        !labelsOwn[0].field.includes('(from') &&
        // A node no label holds for: its other fields are there, and no label.
        labelsNone.owner === 'Shop IT' &&
        labelsNone.fields.length === 0,
      { labelsInherited, labelsOwn, labelsNone },
    );
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);

    // The summary of a closed group is written in the muted colour; on a tint it is darker.
    const exposureAgain = await colourBy('preset:Exposure');
    await setClosed('storefront', true);
    await setClosed('platform', true);
    const summaryColours = () =>
      evaluate(`['storefront', 'platform'].map((id) => {
        const body = document.querySelector('.react-flow__node[data-id="' + id + '"] .arch-collapsed-body');
        return body ? getComputedStyle(body).color : null;
      })`);
    const summariesTinted = await summaryColours();
    await colourBy('none');
    await until(`window.__smoke.count('.arch-tinted') === 0`, 'nothing tinted');
    const summariesPlain = await summaryColours();
    check(
      'the summary of a tinted closed group is not in the muted colour',
      exposureAgain &&
        summariesTinted[0] !== null &&
        summariesTinted[1] !== null &&
        summariesTinted[0] !== summariesTinted[1] &&
        summariesPlain[0] !== null &&
        summariesPlain[0] === summariesPlain[1] &&
        summariesPlain[1] === summariesTinted[1],
      { summariesTinted, summariesPlain },
    );

    // A saved view and a link carry the name of the preset. Each is applied where nothing is
    // coloured and no group is closed, so that what the map shows then comes from it: the view
    // is saved with Platform Services closed.
    await setClosed('storefront', false);
    const lifecycleChosen = await colourBy('preset:Lifecycle');
    await saveView('Lifecycle');
    await until(
      `window.__smoke.count('#views-list li[data-view-name="Lifecycle"]') === 1`,
      'the view with the preset saved',
    );
    const lifecycleShown = `window.__smoke.attr('data-color-by') === 'preset:Lifecycle' && window.__smoke.attr('data-collapsed-count') === '1' && window.__smoke.count('.react-flow__node[data-id="platform"] [data-collapsed="true"]') === 1 && window.__smoke.attr('data-lines-laid-out') === 'true'`;
    /** Holds in the page once no closed Platform Services is kept in the browser. */
    const platformNotKept = `Object.keys(localStorage).every((key) => !key.startsWith('architecture-map.collapsed:') || !(localStorage.getItem(key) ?? '').includes('"platform"'))`;
    const colourKept = () =>
      evaluate(
        `JSON.parse(localStorage.getItem('architecture-map.settings') ?? '{}').colorBy ?? null`,
      );
    await colourBy('none');
    await setClosed('platform', false);
    await evaluate(
      `document.querySelector('#views-list li[data-view-name="Lifecycle"] .views-apply').click()`,
    );
    const viewApplied = await eventually(
      lifecycleShown,
      'the preset and the closed group of the view',
    );
    await settled();
    const legendOfView = await colourLegend();
    await evaluate(`document.querySelector('#copy-view-link').click()`);
    await until(`window.location.hash.startsWith('#view=')`, 'the link in the address bar');
    /** @type {string} */
    const lifecycleHash = await evaluate(`window.location.hash`);
    const lifecycleLink = JSON.parse(
      Buffer.from(lifecycleHash.slice('#view='.length), 'base64url').toString('utf8'),
    );
    /**
     * Reloads the page with the fragment in its address and gives it its files again, as
     * `reloadWith` does, and returns what the page shows before it has them: the notice of a
     * view (none: there is no map to say it of) and where the template is.
     * @param {string} hash
     */
    const reloadSeeingStart = async (hash) => {
      await evaluate(
        `window.history.replaceState(null, '', window.location.href.split('#')[0] + ${JSON.stringify(hash)})`,
      );
      await client.send('Page.reload');
      await startPage();
      const seen = await evaluate(`({
        viewNotes: document.querySelectorAll('#view-note').length,
        hint: document.querySelector('#empty-state #template-hint')?.textContent ?? null,
      })`);
      await dropFiles(dataFiles);
      await until(
        `document.readyState === 'complete' && document.querySelectorAll('.react-flow__node').length > 0`,
        'the map after the reload',
      );
      await evaluate(PAGE_HELPERS);
      await until(`window.__smoke.attr('data-lines-laid-out') === 'true'`, 'the reloaded layout');
      return seen;
    };
    await colourBy('none');
    await setClosed('platform', false);
    await until(
      `${platformNotKept} && JSON.parse(localStorage.getItem('architecture-map.settings') ?? '{}').colorBy === 'none'`,
      'nothing coloured and nothing closed kept in the browser',
    );
    const startOfLink = await reloadSeeingStart(lifecycleHash);
    const linkApplied = await eventually(
      lifecycleShown,
      'the preset and the closed group of the link',
    );
    await settled();
    const legendOfLink = await colourLegend();
    const notesOnMap = await countOf('#view-note');
    check(
      'a saved view and a link keep the preset',
      lifecycleChosen &&
        viewApplied &&
        legendOfView !== null &&
        legendOfView.colorBy === 'preset:Lifecycle' &&
        same(legendOfView.values, ['planned', 'live', 'deprecated']) &&
        lifecycleLink.colorBy === 'preset:Lifecycle' &&
        linkApplied &&
        legendOfLink !== null &&
        legendOfLink.title === 'Lifecycle' &&
        same(legendOfLink.values, ['planned', 'live', 'deprecated']),
      { viewApplied, legendOfView, linked: lifecycleLink.colorBy, linkApplied, legendOfLink },
    );

    // The same link with a preset the file does not have: the rest of the view is applied, the
    // boxes are not coloured, and a notice above the map says why. It is opened where the
    // preset of the link before is still the colouring, and no group is closed.
    await setClosed('platform', false);
    await until(platformNotKept, 'no closed group kept in the browser');
    const keptBeforeNope = await colourKept();
    const startOfNope = await reloadSeeingStart(
      linkOf({ ...lifecycleLink, colorBy: 'preset:Nope' }),
    );
    await until(
      `window.__smoke.attr('data-collapsed-count') === '1' && window.__smoke.attr('data-lines-laid-out') === 'true'`,
      'the closed group of the link without its preset',
    );
    const noteComes = await eventually(
      `window.__smoke.count('#view-note') === 1 && window.__smoke.attr('data-color-by') === 'none'`,
      'the notice of the view',
    );
    await settled();
    const nope = await evaluate(`({
      note: window.__smoke.text('#view-note'),
      status: window.__smoke.count('p#view-note.notice[role="status"]'),
      colorBy: window.__smoke.attr('data-color-by'),
      chosen: document.querySelector('#color-by')?.value ?? null,
      tinted: window.__smoke.count('.arch-tinted'),
      legends: window.__smoke.count('#color-legend'),
      closed: window.__smoke.count('.react-flow__node[data-id="platform"] [data-collapsed="true"]'),
      lodMode: window.__smoke.attr('data-lod-mode'),
      kept: JSON.parse(localStorage.getItem('architecture-map.settings') ?? '{}').colorBy ?? null,
    })`);
    const ownerAfterNote = await colourBy('owner');
    const notesColoured = await countOf('#view-note');
    await colourBy('none');
    await evaluate(`window.__smoke.frames()`);
    const notesAfterwards = await countOf('#view-note');
    check(
      'a view whose colouring the file does not have says so',
      templateAtStart.viewNotes === 0 &&
        startOfLink.viewNotes === 0 &&
        notesOnMap === 0 &&
        startOfNope.viewNotes === 0 &&
        keptBeforeNope === 'preset:Lifecycle' &&
        noteComes &&
        nope.note ===
          'This view is coloured by preset "Nope", which this file does not have: the boxes are not coloured.' &&
        nope.status === 1 &&
        nope.colorBy === 'none' &&
        nope.chosen === 'none' &&
        nope.tinted === 0 &&
        nope.legends === 0 &&
        nope.closed === 1 &&
        nope.lodMode === lifecycleLink.lodMode &&
        nope.kept === 'none' &&
        ownerAfterNote &&
        notesColoured === 0 &&
        notesAfterwards === 0,
      {
        atStart: [templateAtStart.viewNotes, startOfLink.viewNotes, startOfNope.viewNotes],
        notesOnMap,
        keptBeforeNope,
        nope,
        notesColoured,
        notesAfterwards,
      },
    );

    // Where the template is: the same sentence on the empty page and on the Files tab, there
    // with and without a map.
    const templateWithMap = {
      note: await text('#template-note'),
      hints: await countOf('#template-hint'),
    };
    check(
      'the viewer says where the template is',
      typeof templateAtStart.hint === 'string' &&
        templateAtStart.hint.includes('template/architecture.yaml') &&
        templateAtStart.hint.includes('template/workitems.json') &&
        templateAtStart.hintShown &&
        templateAtStart.note === templateAtStart.hint &&
        templateAtStart.noteShown &&
        startOfLink.hint === templateAtStart.hint &&
        templateWithMap.note === templateAtStart.hint &&
        templateWithMap.hints === 0,
      { templateAtStart, again: startOfLink.hint, templateWithMap },
    );

    // Back to the map as it was: no link in the address, no view of these checks, the level, the
    // groups, the place and the colouring of the view saved at the start, and the tab.
    await evaluate(
      `window.history.replaceState(null, '', window.location.href.split('#')[0] + ${JSON.stringify(labelsStart.hash)})`,
    );
    await evaluate(
      `document.querySelector('#views-list li[data-view-name="Lifecycle"] .views-delete').click()`,
    );
    await evaluate(
      `document.querySelector('#views-list li[data-view-name="${LABELS_VIEW}"] .views-apply').click()`,
    );
    await until(
      `window.__smoke.attr('data-lod-mode') === ${JSON.stringify(labelsStart.lodMode)} && window.__smoke.attr('data-collapsed-count') === ${JSON.stringify(labelsStart.collapsed)} && window.__smoke.attr('data-color-by') === ${JSON.stringify(labelsStart.colorBy)} && window.__smoke.attr('data-lines-laid-out') === 'true'`,
      'the map as it was before the labels',
    );
    await settled();
    await evaluate(
      `document.querySelector('#views-list li[data-view-name="${LABELS_VIEW}"] .views-delete').click()`,
    );
    await until(
      `window.__smoke.count('#views-list li[data-view-name="${LABELS_VIEW}"], #views-list li[data-view-name="Lifecycle"]') === 0`,
      'the views of the labels deleted',
    );
    if ((await attr('data-panel-tab')) !== labelsStart.tab) {
      await click(`#tab-${labelsStart.tab}`);
      await until(
        `window.__smoke.attr('data-panel-tab') === '${labelsStart.tab}'`,
        'the tab shown before the labels',
      );
    }

    // Edges on demand, at every level of detail.
    await setSetting('edges-on-demand', true);
    await until(`window.__smoke.attr('data-edges-held-back') === 'true'`, 'edges on demand');
    /** Whether every edge drawn comes to be hidden: false when that does not come in time. */
    const everyEdgeHidden = () =>
      eventually(
        `window.__smoke.count('.react-flow__edge') > 0 && window.__smoke.count('.react-flow__edge:not(.arch-quiet)') === 0`,
        'every edge hidden',
      );
    // The pointer rests on the last box clicked, whose edges would stay: park it.
    await park();
    await everyEdgeHidden();
    const edgesAll = await countOf('.react-flow__edge');
    check(
      'edges on demand hides every edge at the Components level while nothing is selected',
      edgesAll > 0 && (await countOf('.react-flow__edge.arch-quiet')) === edgesAll,
    );
    await click('.react-flow__node[data-id="data.event-store"]');
    await untilSelection('node:data.event-store');
    /** The rendered edges shown, by their IDs (`source>target:kind`). */
    const loudEdges = async () =>
      /** @type {string[]} */ (
        await evaluate(
          `[...document.querySelectorAll('.react-flow__edge:not(.arch-quiet)')].map((e) => e.dataset.id)`,
        )
      );
    /** Whether an end of the rendered edge `id` is one of `ids`. */
    const edgeAt = (/** @type {string} */ id, /** @type {string[]} */ ids) =>
      (id.split(':')[0] ?? '').split('>').some((end) => ids.includes(end));
    await eventually(
      `window.__smoke.count('.react-flow__edge:not(.arch-quiet)') > 0`,
      'the edges of the selected box',
    );
    const loud = await loudEdges();
    check(
      'the selected box brings its own edges back',
      loud.length > 0 && loud.every((id) => edgeAt(id, ['data.event-store'])),
      loud,
    );
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    /** Moves the pointer onto the element: real input, so that React Flow sees it enter. */
    const hover = async (/** @type {string} */ selector) => {
      const point = await until(
        `window.__smoke.clickPoint(${JSON.stringify(selector)})`,
        `a point of ${selector}`,
      );
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    };
    /**
     * Hovers the element and waits until the edges shown are some, all at `ids`: those, or null
     * when that does not come.
     * @param {string} selector @param {string[]} ids @param {string} what
     */
    const hoverShows = async (selector, ids, what) => {
      await hover(selector);
      return waitFor(async () => {
        const shown = await loudEdges();
        return shown.length > 0 && shown.every((id) => edgeAt(id, ids)) ? shown : null;
      }, what).catch(() => null);
    };
    const storeBox = '.react-flow__node[data-id="data.event-store"]';
    const ingest = ['data.ingest', 'data.ingest.broker', 'data.ingest.normalizer'];
    for (const [level, name] of /** @type {[string, string][]} */ ([
      ['subcomponents', 'Subcomponents'],
      ['detail', 'Everything'],
    ])) {
      await pinLod(level);
      await click('#fit-view');
      await settled();
      await park();
      await everyEdgeHidden();
      const all = await countOf('.react-flow__edge');
      check(
        `edges on demand also hides every edge at the ${name} level`,
        (await attr('data-edges-held-back')) === 'true' &&
          all > 0 &&
          (await countOf('.react-flow__edge.arch-quiet')) === all,
        { all },
      );
      // A box under the pointer: its edges show, and the others stay hidden.
      const leaf = await hoverShows(storeBox, ['data.event-store'], `the edges of the box`);
      check(
        `at the ${name} level the box under the pointer shows its own edges, and only those`,
        leaf !== null && (await countOf('.react-flow__edge.arch-quiet')) > 0,
        leaf,
      );
      // The frame of an open group shows the edges of all it draws; a box inside it its own.
      const frame = await hoverShows(
        '.react-flow__node[data-id="data.ingest"]',
        ingest,
        'the edges of the open group',
      );
      check(
        `at the ${name} level the frame of an open group shows the edges at it and inside it`,
        frame !== null &&
          frame.some((id) => edgeAt(id, ['data.ingest.broker'])) &&
          frame.some((id) => edgeAt(id, ['data.ingest.normalizer'])),
        frame,
      );
      const inner = await hoverShows(
        '.react-flow__node[data-id="data.ingest.broker"]',
        ['data.ingest.broker'],
        'the edges of the box inside the group',
      );
      check(
        `at the ${name} level a box inside an open group shows only its own edges`,
        inner !== null && inner.length < (frame?.length ?? 0),
        inner,
      );
      if (level === 'subcomponents') {
        // The pointer can follow a shown edge from its box, and click it.
        const followed = inner?.[0];
        const edge = `.react-flow__edge[data-id="${followed}"]`;
        /** @type {{ x: number, y: number } | null} */
        const onEdge =
          followed === undefined
            ? null
            : await evaluate(`window.__smoke.clickPoint(${JSON.stringify(edge)})`);
        if (onEdge) {
          await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...onEdge });
          // Once the pointer is on the edge, the edge must still be shown a moment later.
          const reached = await eventually(
            `window.__smoke.count(${JSON.stringify(`${edge}:hover`)}) === 1`,
            'the pointer on the edge',
          );
          await sleep(300);
          const stays = (await countOf(`${edge}.arch-quiet`)) === 0;
          await clickAt(onEdge, edge);
          const clicked = await eventually(
            `window.__smoke.count(${JSON.stringify(`${edge}.selected`)}) === 1`,
            'the edge selected',
          );
          const selected = await attr('data-selection');
          check(
            'a shown edge stays while the pointer follows it from its box, and can be clicked',
            reached && stays && clicked && (await countOf(`${edge}.selected`)) === 1,
            { followed, reached, stays, selected },
          );
          await press('Escape', { keyCode: 27 });
          await untilSelection(null);
        } else {
          check('a shown edge of the box can be reached by the pointer', false, { followed });
        }
      }
      // The focus overrides: its edges show without the pointer; a box adds its own.
      await chooseOption('#focus-select', 'flow:telemetry-to-dashboards');
      await until(
        `window.__smoke.attr('data-focus') === 'flow:telemetry-to-dashboards'`,
        'the focus on the flow',
      );
      await park();
      const focusShown = await eventually(
        `window.__smoke.count('.react-flow__edge:not(.arch-faded)') > 0 && window.__smoke.count('.react-flow__edge:not(.arch-faded).arch-quiet') === 0 && window.__smoke.count('.react-flow__edge.arch-faded:not(.arch-quiet)') === 0`,
        'the edges of the focus alone',
      );
      check(
        `at the ${name} level every edge of the focus shows, and no other`,
        focusShown &&
          (await countOf('.react-flow__edge:not(.arch-faded)')) > 0 &&
          (await countOf('.react-flow__edge:not(.arch-faded).arch-quiet')) === 0 &&
          (await countOf('.react-flow__edge.arch-faded:not(.arch-quiet)')) === 0,
      );
      await hover(storeBox);
      /** @type {string[]} */
      const added = await waitFor(async () => {
        /** @type {string[]} */
        const ids = await evaluate(
          `[...document.querySelectorAll('.react-flow__edge.arch-faded:not(.arch-quiet)')].map((e) => e.dataset.id)`,
        );
        return ids.length > 0 ? ids : null;
      }, 'the edges of the box beside those of the focus').catch(() => []);
      check(
        `at the ${name} level the box under the pointer adds its edges to those of the focus`,
        added.length > 0 &&
          added.every((id) => edgeAt(id, ['data.event-store'])) &&
          (await countOf('.react-flow__edge:not(.arch-faded).arch-quiet')) === 0,
        added,
      );
      await click('#focus-clear');
      await until(`window.__smoke.attr('data-focus') === null`, 'the focus cleared');
      // Switched off, every edge shows.
      await setSetting('edges-on-demand', false);
      check(
        `with edges on demand off every edge shows at the ${name} level`,
        (await attr('data-edges-held-back')) === 'false' &&
          (await countOf('.react-flow__edge.arch-quiet')) === 0,
      );
      await setSetting('edges-on-demand', true);
      await until(`window.__smoke.attr('data-edges-held-back') === 'true'`, 'edges on demand');
    }
    await setSetting('edges-on-demand', false);
    // The hit area of an edge reaches into the boxes at its ends: on the way out of a box along
    // one of its edges the pointer is never on the group around the box, or on the empty canvas.
    // First by what lies under each point of that way, with every edge shown.
    /** @typedef {{ edge: string, box: string, points: { x: number, y: number }[], under: string[] }} EdgeEnd */
    const edgeEnds = (/** @type {number} */ inside, /** @type {number} */ outside) =>
      /** @type {Promise<EdgeEnd[]>} */ (
        evaluate(`window.__smoke.edgeEnds(${inside}, ${outside})`)
      );
    /** What the way out of the box comes on that is not on it: a group around the box, or "pane". */
    const offTheWay = (/** @type {EdgeEnd} */ end) =>
      end.under.find((what) => what === 'pane' || end.box.startsWith(`${what}.`));
    // Nothing selected: the bar of a focus or the detail panel would lie over part of the canvas.
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    /** @type {string[]} */
    const gaps = [];
    const waysOut = { ends: 0, fromTheBox: 0 };
    for (const level of ['domains', 'components', 'subcomponents']) {
      await pinLod(level);
      await click('#fit-view');
      await settled();
      await park();
      for (const end of await edgeEnds(4, 10)) {
        // Not where a legend or the controls lie over the canvas.
        if (end.under.includes('covered')) continue;
        waysOut.ends += 1;
        if (end.under[0] === 'box') waysOut.fromTheBox += 1;
        const off = offTheWay(end);
        if (off !== undefined) gaps.push(`${level}: ${end.edge} at ${end.box} on ${off}`);
      }
    }
    check(
      'between a box and an edge attached to it nothing else lies under the pointer, at the Domains, Components and Subcomponents levels',
      waysOut.ends > 100 && waysOut.fromTheBox > 0.8 * waysOut.ends && gaps.length === 0,
      { ...waysOut, gaps: gaps.slice(0, 6) },
    );
    // Then with the pointer itself and edges on demand, where a point off the box and the line
    // would show other edges, or none: out of every domain at the Domains level, where what lies
    // around a box is the empty canvas, and out of the components of two domains at the
    // Components level, where it is the domain.
    await setSetting('edges-on-demand', true);
    await until(`window.__smoke.attr('data-edges-held-back') === 'true'`, 'edges on demand');
    /** @type {string[]} */
    const strayed = [];
    let walked = 0;
    for (const [level, inDomains] of /** @type {[string, string[]][]} */ ([
      ['domains', []],
      ['components', ['storefront', 'data']],
    ])) {
      await pinLod(level);
      await click('#fit-view');
      await settled();
      /** @type {string[]} */
      const closed = await evaluate(`window.__smoke.closedBoxes()`);
      /** @type {string[]} */
      const drawnEdges = await evaluate(`window.__smoke.edgeIds()`);
      const boxes = closed.filter(
        (box) =>
          (level === 'domains' || inDomains.some((domain) => box.startsWith(`${domain}.`))) &&
          drawnEdges.some((id) => edgeAt(id, [box])),
      );
      for (const box of boxes) {
        const selector = `.react-flow__node[data-id="${box}"]`;
        const own = await hoverShows(selector, [box], `the edges of ${box}`);
        if (own === null) {
          strayed.push(`${level}: ${box} shows no edges of its own`);
          continue;
        }
        const shownAtBox = [...own].sort().join();
        for (const end of await edgeEnds(3, 6)) {
          // Only a way that stays on the box and its line: another box in the way takes over.
          if (end.box !== box || !own.includes(end.edge)) continue;
          if (
            end.under.some(
              (what) => !['box', 'edge', 'pane'].includes(what) && !box.startsWith(`${what}.`),
            )
          )
            continue;
          if ((await hoverShows(selector, [box], `the edges of ${box} again`)) === null) {
            strayed.push(`${level}: the edges of ${box} did not come back`);
            continue;
          }
          for (const point of end.points) {
            await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
          }
          await evaluate(`window.__smoke.frames()`);
          const shown = (await loudEdges()).sort().join();
          const onTheLine = (await countOf('.react-flow__edge:hover')) > 0;
          walked += 1;
          if (!onTheLine || shown !== shownAtBox) {
            strayed.push(
              `${level}: ${end.edge} out of ${box}: ${own.length} edges, then ${shown === '' ? 0 : shown.split(',').length}${onTheLine ? '' : ', off the line'}`,
            );
          }
        }
      }
    }
    check(
      'edges on demand: the pointer moved out of a box along one of its edges, pixel by pixel, keeps the edges of that box shown',
      walked > 40 && strayed.length === 0,
      { walked, strayed: strayed.slice(0, 6) },
    );
    await park();
    await setSetting('edges-on-demand', false);
    await pinLod('components');
    // Saved views: save, change the map, come back; a link carries the view.
    await evaluate(`(() => {
      const input = document.querySelector('#view-name');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Components overview');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await evaluate(`document.querySelector('#save-view').click()`);
    await until(`window.__smoke.count('#views-list li') === 1`, 'the saved view');
    await evaluate(`document.querySelector('#copy-view-link').click()`);
    await until(`window.location.hash.startsWith('#view=')`, 'the link in the address bar');
    const viewHash = await evaluate(`window.location.hash`);
    await click('#collapse-all');
    await until(`Number(window.__smoke.attr('data-collapsed-count')) > 0`, 'groups collapsed');
    await pinLod('subcomponents');
    await evaluate(`document.querySelector('#views-list .views-apply').click()`);
    await until(`window.__smoke.attr('data-collapsed-count') === '0'`, 'the view applied');
    await until(`window.__smoke.attr('data-lod-mode') === 'components'`, 'its level of detail');
    check(
      'a saved view brings back the collapsed groups and the level of detail',
      (await evaluate(`window.__smoke.attr('data-lod-mode')`)) === 'components',
    );
    await evaluate(`document.querySelector('#views-list .views-delete').click()`);
    await until(`window.__smoke.count('#views-list li') === 0`, 'the view deleted');
    // The link: collapse again, reload with the fragment, and the view is back.
    await click('#collapse-all');
    await until(
      `Number(window.__smoke.attr('data-collapsed-count')) > 0`,
      'groups collapsed again',
    );
    await sleep(700); // the collapsed set is stored
    await reloadWith(viewHash);
    await until(`window.__smoke.attr('data-collapsed-count') === '0'`, 'the linked view applied');
    check(
      'a link with a view opens the map in that view',
      (await evaluate(`window.__smoke.attr('data-lod-mode')`)) === 'components' &&
        (await evaluate(`window.location.hash`)).startsWith('#view='),
    );
    // Leave no trace for the checks that follow: the fragment would apply the view on every load.
    await reloadWith('');
    await sleep(300);

    // --- Close up the gaps: closed groups shrunk, the boxes drawn moved together --------------
    /**
     * What is on screen in one frame (`window.__smoke.frame()`).
     * @typedef {object} Frame
     * @property {string | null} arrangement
     * @property {string | null} lod
     * @property {number | null} zoom
     * @property {{ x: number, y: number }} mid
     * @property {Record<string, [number, number, number, number]>} boxes left, top, width, height
     */
    /** @typedef {{ before: Frame, after: Frame[] }} Change */
    /** @typedef {{ id: string | null, dx: number, dy: number, shift: number }} Shift */

    /** Errors the page reports from here on; none is expected. @type {string[]} */
    const pageErrors = [];
    client.on('Runtime.exceptionThrown', (params) => {
      pageErrors.push(
        params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? '?',
      );
    });
    client.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        pageErrors.push(String(params.args?.[0]?.value ?? params.args?.[0]?.description ?? '?'));
      }
    });
    const LEVELS = ['domains', 'components', 'subcomponents', 'detail'];
    /** The example's groups that span rows. */
    const SPANNING = ['operations', 'data', 'data.analytics'];
    const START_VIEW = 'Before closing up';
    const closeUpStart = {
      tab: await attr('data-panel-tab'),
      panelCollapsed: await attr('data-panel-collapsed'),
      rows: await attr('data-show-rows'),
      shrink: await attr('data-compact-collapsed'),
      focusMode: await attr('data-focus-mode'),
      lodMode: await attr('data-lod-mode'),
      collapsed: await attr('data-collapsed-count'),
    };
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await saveView(START_VIEW);
    await until(
      `window.__smoke.count('#views-list li[data-view-name="${START_VIEW}"]') === 1`,
      'the view to come back to',
    );
    // The body of the control panel open on the Layout tab: the canvas keeps its width from here.
    await showControl('#close-gaps');

    const frame = () => /** @type {Promise<Frame>} */ (evaluate(`window.__smoke.frame()`));
    const watchArrangement = () => evaluate(`window.__smoke.watchArrangement()`);
    const arrangementChanges = () =>
      /** @type {Promise<Change[]>} */ (evaluate(`window.__smoke.arrangementChanges()`));
    const canvasBoxes = () =>
      /** @type {Promise<Record<string, number[] | null>>} */ (
        evaluate(`window.__smoke.canvasBoxes()`)
      );
    const layoutProblems = () =>
      /** @type {Promise<string[]>} */ (evaluate(`window.__smoke.layoutProblems()`));
    const markCanvas = () =>
      /** @type {Promise<string>} */ (evaluate(`window.__smoke.markCanvas()`));
    const sameCanvas = async (/** @type {string} */ mark) =>
      (await evaluate(`window.__smoke.canvasMark()`)) === mark;
    const levelsDuring = (/** @type {number} */ ms) =>
      /** @type {Promise<string[]>} */ (evaluate(`window.__smoke.levelsDuring(${ms})`));
    const shrinkControl = () => evaluate(`window.__smoke.shrinkControl()`);
    /** Whether two boxes are the same, within half a pixel. */
    const sameBox = (
      /** @type {number[] | null | undefined} */ a,
      /** @type {number[] | null | undefined} */ b,
    ) =>
      !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) <= 0.5);
    /** The boxes drawn that are not where `reference` has them. */
    const movedFrom = async (/** @type {Record<string, number[] | null>} */ reference) =>
      Object.entries(await canvasBoxes())
        .filter(([id, box]) => !sameBox(box, reference[id]))
        .map(([id]) => id);
    /** The area of a `data-layout-size`. */
    const areaOf = (/** @type {string | null} */ size) => {
      const [width, height] = String(size).split('x').map(Number);
      return (width ?? NaN) * (height ?? NaN);
    };
    /** Switches Close up the gaps with a click on it and waits until the map follows. */
    const closeUp = async (/** @type {boolean} */ on) => {
      if ((await attr('data-close-gaps')) !== String(on)) await click('#close-gaps');
      await until(
        `window.__smoke.attr('data-close-gaps') === '${on}'`,
        `Close up the gaps ${on ? 'on' : 'off'}`,
      );
      await settled();
    };
    /** Switches Arrange in rows with a click on it and waits for the map laid out for it. */
    const showRows = async (/** @type {boolean} */ on) => {
      if ((await attr('data-show-rows')) !== String(on)) await click('#show-rows');
      await until(
        `window.__smoke.attr('data-show-rows') === '${on}' && window.__smoke.attr('data-layout-pending') === 'false' && window.__smoke.attr('data-lines-laid-out') === 'true' && (window.__smoke.count('.react-flow__node-band') > 0) === ${on}`,
        `the map ${on ? 'in rows' : 'without rows'}`,
      );
      await settled();
    };
    const fit = async () => {
      await click('#fit-view');
      await settled();
    };
    /**
     * Collapses the groups by their chevrons, one after the other, each brought to the middle
     * of the canvas first (on the fitted map a legend may lie over a chevron).
     */
    const closeByHand = async (/** @type {string[]} */ ids) => {
      const before = Number(await attr('data-collapsed-count'));
      for (const [i, id] of ids.entries()) {
        await centreOn(id);
        await click(`.react-flow__node[data-id="${id}"] .arch-chevron`);
        await until(
          `window.__smoke.attr('data-collapsed-count') === '${before + i + 1}'`,
          `${id} closed`,
        );
      }
      await settled();
    };
    const expandAll = async () => {
      await click('#expand-all');
      await until(`window.__smoke.attr('data-collapsed-count') === '0'`, 'everything expanded');
      await settled();
    };
    /**
     * Pans the canvas with the mouse until the middle of the node `id` is in the middle of the
     * canvas (within 3 px).
     * @param {string} id
     */
    const centreOn = async (id) => {
      const selector = JSON.stringify(`.react-flow__node[data-id="${id}"]`);
      for (let turn = 0; turn < 4; turn++) {
        const offset = await evaluate(`window.__smoke.centreOffset(${selector})`);
        if (offset === null) break;
        if (Math.abs(offset.dx) <= 3 && Math.abs(offset.dy) <= 3) return;
        const plan = await evaluate(`window.__smoke.panPlan(${-offset.dx}, ${-offset.dy})`);
        if (plan === null) break;
        await drag(plan.from, plan.to);
        await settled();
      }
      throw new Error(`cannot bring ${id} to the middle of the canvas`);
    };
    /**
     * Turns the mouse wheel over the middle of the canvas until the zoom selects `level` (Auto),
     * then waits until that level is drawn and settled and the view is at rest.
     * @param {string} level
     */
    const zoomToLevel = async (level) => {
      const middle = await evaluate(`window.__smoke.canvasMiddle()`);
      if (!middle.onCanvas) throw new Error('something lies over the middle of the canvas');
      for (let turn = 0; turn < 24; turn++) {
        const now = await attr('data-zoom-lod');
        if (now === level) break;
        const finer = LEVELS.indexOf(level) > LEVELS.indexOf(now);
        const { zoom } = await viewNow();
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: middle.x,
          y: middle.y,
          deltaX: 0,
          deltaY: finer ? -200 : 200,
        });
        await until(
          `window.__smoke.viewport().zoom ${finer ? '>' : '<'} ${zoom}`,
          'the zoom after a wheel turn',
        );
      }
      await until(
        `window.__smoke.attr('data-zoom-lod') === '${level}' && window.__smoke.attr('data-lod') === '${level}' && window.__smoke.attr('data-level-settled') === 'true' && window.__smoke.attr('data-lines-laid-out') === 'true'`,
        `the ${level} level by zoom, drawn`,
      );
      await settled();
    };
    /**
     * How far the place in the middle of the canvas moved from `before` to `after`. The anchor
     * is the innermost box under the middle in `before` that `rest` (the frame the view came to
     * rest in) draws too; the point of it that was in the middle is measured against the middle
     * of `after`. With no box under the middle, the nearest box keeps its distance to it.
     * @param {Frame} before @param {Frame} after @param {Frame} [rest]
     * @returns {Shift}
     */
    const placeShift = (before, after, rest = after) => {
      const { x: cx, y: cy } = before.mid;
      /** @type {{ id: string, area: number } | undefined} */
      let inside;
      /** @type {{ id: string, distance: number } | undefined} */
      let nearest;
      for (const [id, [x, y, width, height]] of Object.entries(before.boxes)) {
        if (rest.boxes[id] === undefined || !(width > 0 && height > 0)) continue;
        const dx = Math.max(x - cx, 0, cx - (x + width));
        const dy = Math.max(y - cy, 0, cy - (y + height));
        if (dx === 0 && dy === 0) {
          if (!inside || width * height < inside.area) inside = { id, area: width * height };
        } else {
          const distance = Math.hypot(dx, dy);
          if (!nearest || distance < nearest.distance) nearest = { id, distance };
        }
      }
      const id = inside?.id ?? nearest?.id;
      const from = id === undefined ? undefined : before.boxes[id];
      const to = id === undefined ? undefined : after.boxes[id];
      if (id === undefined || !from || !to) {
        return { id: id ?? null, dx: NaN, dy: NaN, shift: Infinity };
      }
      const [fx, fy, fw, fh] = from;
      const [tx, ty, tw, th] = to;
      const point = inside
        ? { x: tx + ((cx - fx) / fw) * tw, y: ty + ((cy - fy) / fh) * th }
        : { x: tx + tw / 2 + (cx - (fx + fw / 2)), y: ty + th / 2 + (cy - (fy + fh / 2)) };
      const dx = point.x - after.mid.x;
      const dy = point.y - after.mid.y;
      return { id, dx, dy, shift: Math.max(Math.abs(dx), Math.abs(dy)) };
    };
    /**
     * How far the top left corner of the box `id` moved on screen from `before` to `after`.
     * @param {Frame} before @param {Frame} after @param {string} id
     * @returns {Shift}
     */
    const cornerShift = (before, after, id) => {
      const from = before.boxes[id];
      const to = after.boxes[id];
      if (!from || !to) return { id, dx: NaN, dy: NaN, shift: Infinity };
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      return { id, dx, dy, shift: Math.max(Math.abs(dx), Math.abs(dy)) };
    };
    /**
     * The largest shift of an anchor between the frame before a change and each frame after it,
     * the frame the view rested in included; `frame` is its index (the last one: at rest).
     * @param {Change | undefined} change @param {Frame} rest
     * @param {(before: Frame, after: Frame) => Shift} measure
     */
    const worstShift = (change, rest, measure) => {
      if (!change) return { id: null, dx: NaN, dy: NaN, shift: Infinity, frame: -1, frames: 0 };
      const frames = [...change.after, rest];
      let worst = { ...measure(change.before, rest), frame: frames.length - 1 };
      frames.forEach((after, index) => {
        const shift = measure(change.before, after);
        if (!(shift.shift <= worst.shift)) worst = { ...shift, frame: index };
      });
      return { ...worst, frames: frames.length };
    };
    /** Whether the zoom is the same in every frame after the change as before it. */
    const zoomKept = (/** @type {Change | undefined} */ change) =>
      !!change &&
      change.after.every(
        (after) => Math.abs((after.zoom ?? NaN) - (change.before.zoom ?? NaN)) < 1e-6,
      );
    /** The boxes, other than `id` and those in it or around it, that moved more than 4 px on screen. */
    const othersMoved = (/** @type {Frame} */ before, /** @type {Frame} */ after, id = '') =>
      Object.keys(before.boxes).filter((other) => {
        if (other === id || other.startsWith(`${id}.`) || id.startsWith(`${other}.`)) return false;
        const { shift } = cornerShift(before, after, other);
        return Number.isFinite(shift) && shift > 4;
      });
    /**
     * Runs `act`, which changes the arrangement, and waits until `done` holds in the page and the
     * view is at rest. Returns the one change seen (undefined unless there was exactly one), the
     * frame at rest, and whether the canvas is still the same element.
     * @param {() => Promise<unknown>} act @param {string} done @param {string} what
     */
    const watched = async (act, done, what) => {
      const mark = await markCanvas();
      await watchArrangement();
      await act();
      await until(done, what);
      await settled();
      const rest = await frame();
      const changes = await arrangementChanges();
      return {
        change: changes.length === 1 ? changes[0] : undefined,
        changes: changes.length,
        rest,
        sameCanvas: await sameCanvas(mark),
      };
    };

    // With the option off, the map is the full layout: every box drawn where the expanded map
    // has it, at every level and with groups closed by hand. With it on, no box overlaps another
    // and every box lies inside its group, at every level; with every group open the expanded
    // levels draw the full map.
    await setSetting('compact-collapsed', false);
    await until(`window.__smoke.attr('data-compact-collapsed') === 'false'`, 'Shrink off');
    await expandAll();
    for (const rows of [true, false]) {
      const rowsName = rows ? 'with rows' : 'without rows';
      await showRows(rows);
      await closeUp(false);
      await pinLod('subcomponents');
      const reference = await canvasBoxes();
      /** @type {string[]} */
      const offMoved = [];
      /** @type {Record<string, string | null>} */
      const offArrangements = {};
      for (const level of ['domains', 'components']) {
        await pinLod(level);
        offArrangements[level] = await attr('data-arrangement');
        offMoved.push(...(await movedFrom(reference)).map((id) => `${level}: ${id}`));
      }
      await pinLod('subcomponents');
      await closeByHand(['storefront.gateway', 'backoffice']);
      offArrangements.byHand = await attr('data-arrangement');
      offMoved.push(...(await movedFrom(reference)).map((id) => `by hand: ${id}`));
      await expandAll();
      check(
        `with Close up the gaps off, ${rowsName}, every box is drawn where the expanded map has it, at every level and with groups closed by hand`,
        Object.keys(reference).length > 0 &&
          offMoved.length === 0 &&
          Object.values(offArrangements).every((arrangement) => arrangement === 'full'),
        { offMoved: offMoved.slice(0, 8), offArrangements },
      );
      await closeUp(true);
      const identity = {
        arrangement: await attr('data-arrangement'),
        moved: await movedFrom(reference),
      };
      /** @type {string[]} */
      const onProblems = [];
      /** @type {Record<string, string | null>} */
      const onArrangements = {};
      for (const level of LEVELS) {
        await pinLod(level);
        onArrangements[level] = await attr('data-arrangement');
        onProblems.push(...(await layoutProblems()).map((problem) => `${level}: ${problem}`));
      }
      await pinLod('subcomponents');
      await closeByHand(['storefront.gateway', 'backoffice']);
      onArrangements.byHand = await attr('data-arrangement');
      onProblems.push(...(await layoutProblems()).map((problem) => `by hand: ${problem}`));
      await expandAll();
      check(
        `closed up, ${rowsName}: no box overlaps another and every box lies inside its group, at every level and with groups closed by hand`,
        onProblems.length === 0,
        onProblems.slice(0, 8),
      );
      const closedUp = [onArrangements.domains, onArrangements.components, onArrangements.byHand];
      check(
        `closed up, ${rowsName}: with every group open the expanded levels draw the full map, the coarser levels and the groups closed by hand each another arrangement`,
        identity.arrangement === 'full' &&
          identity.moved.length === 0 &&
          onArrangements.subcomponents === 'full' &&
          onArrangements.detail === 'full' &&
          closedUp.every(
            (arrangement) => typeof arrangement === 'string' && arrangement !== 'full',
          ) &&
          new Set(closedUp).size === 3,
        { identity, onArrangements },
      );
      await closeUp(false);
    }

    // At the Domains level, with rows: closed up, the map takes a fraction of the area, the
    // closed groups are drawn shrunk whatever Shrink collapsed groups says, and that checkbox
    // shows it is on. The box in the middle of the canvas stays where it is, both ways.
    await showRows(true);
    await pinLod('domains');
    await fit();
    await centreOn('storefront');
    const sizeFull = await attr('data-layout-size');
    /** @type {{ checked: boolean | null, disabled: boolean | null, stored: string | null }} */
    const shrinkOff = await shrinkControl();
    const toDomainsClosed = await watched(
      () => closeUp(true),
      `window.__smoke.attr('data-arrangement') !== 'full'`,
      'the closed-up map at the Domains level',
    );
    const sizeClosed = await attr('data-layout-size');
    const domainProblems = await layoutProblems();
    const shrunkGroups = await countOf('.arch-group.arch-compact');
    check(
      'Close up the gaps at the Domains level: the map takes less than a third of the area of the full one, and no box overlaps another',
      typeof sizeClosed === 'string' &&
        areaOf(sizeClosed) <= 0.3 * areaOf(sizeFull) &&
        toDomainsClosed.rest.arrangement !== 'full' &&
        domainProblems.length === 0,
      { sizeFull, sizeClosed, domainProblems },
    );
    // The example, laid out: a closed domain with a work-item badge is a line higher.
    const domainsExpected = (await attr('data-story-mode')) === 'off' ? '1608x378' : '1608x430';
    check(
      `closed up at the Domains level the example measures ${domainsExpected}, the full map 2484x1120`,
      sizeFull === '2484x1120' && sizeClosed === domainsExpected,
      { sizeFull, sizeClosed },
    );
    const placeOn = worstShift(toDomainsClosed.change, toDomainsClosed.rest, (before, after) =>
      placeShift(before, after, toDomainsClosed.rest),
    );
    check(
      'switching Close up the gaps on keeps the box in the middle of the canvas where it was, in every frame, on the same canvas and at the same zoom',
      placeOn.id === 'storefront' &&
        placeOn.shift <= 2 &&
        zoomKept(toDomainsClosed.change) &&
        toDomainsClosed.sameCanvas,
      { placeOn, changes: toDomainsClosed.changes, sameCanvas: toDomainsClosed.sameCanvas },
    );
    /** @type {typeof shrinkOff} */
    const shrinkOn = await shrinkControl();
    // A real click on the checkbox while it is disabled changes nothing.
    await click('#compact-collapsed');
    await evaluate(`window.__smoke.frames()`);
    /** @type {typeof shrinkOff} */
    const shrinkClicked = await shrinkControl();
    check(
      'while Close up the gaps is on, closed groups are drawn shrunk and Shrink collapsed groups shows checked and cannot be changed; the stored setting stays',
      shrinkOff.checked === false &&
        shrinkOff.disabled === false &&
        shrinkOn.checked === true &&
        shrinkOn.disabled === true &&
        shrinkOn.stored === 'false' &&
        shrinkClicked.checked === true &&
        shrinkClicked.stored === 'false' &&
        shrunkGroups > 0,
      { shrinkOff, shrinkOn, shrinkClicked, shrunkGroups },
    );
    const toDomainsFull = await watched(
      () => closeUp(false),
      `window.__smoke.attr('data-arrangement') === 'full'`,
      'the full map at the Domains level',
    );
    const placeOff = worstShift(toDomainsFull.change, toDomainsFull.rest, (before, after) =>
      placeShift(before, after, toDomainsFull.rest),
    );
    /** @type {typeof shrinkOff} */
    const shrinkBack = await shrinkControl();
    check(
      'switching Close up the gaps off draws the full map again, keeps the box in the middle where it was, and Shrink collapsed groups shows its own setting',
      (await attr('data-layout-size')) === sizeFull &&
        placeOff.id === 'storefront' &&
        placeOff.shift <= 2 &&
        toDomainsFull.sameCanvas &&
        shrinkBack.checked === false &&
        shrinkBack.disabled === false &&
        (await countOf('.arch-group.arch-compact')) === 0,
      { placeOff, shrinkBack, size: await attr('data-layout-size') },
    );
    // With Shrink collapsed groups stored on, it shows checked either way, and can be changed
    // again once the option is off.
    await setSetting('compact-collapsed', true);
    await until(`window.__smoke.attr('data-compact-collapsed') === 'true'`, 'Shrink stored on');
    await closeUp(true);
    /** @type {typeof shrinkOff} */
    const shrinkStoredOn = await shrinkControl();
    await closeUp(false);
    /** @type {typeof shrinkOff} */
    const shrinkStoredBack = await shrinkControl();
    check(
      'Shrink collapsed groups stored on: checked and disabled while Close up the gaps is on, checked and free to change once it is off',
      shrinkStoredOn.checked === true &&
        shrinkStoredOn.disabled === true &&
        shrinkStoredOn.stored === 'true' &&
        shrinkStoredBack.checked === true &&
        shrinkStoredBack.disabled === false &&
        shrinkStoredBack.stored === 'true',
      { shrinkStoredOn, shrinkStoredBack },
    );
    await setSetting('compact-collapsed', false);
    await until(`window.__smoke.attr('data-compact-collapsed') === 'false'`, 'Shrink off again');

    // A group opened or closed by its chevron stays where it is on screen: its top left corner,
    // with the chevron under the pointer, in every frame; the other boxes close up around it.
    // Taken far from the middle of the canvas, and one whose closing moves the place in the
    // middle: keeping the middle where it is would move the group, so the two can be told apart.
    await closeUp(true);
    for (const rows of [false, true]) {
      const rowsName = rows ? 'with rows' : 'without rows';
      await showRows(rows);
      await pinLod('subcomponents');
      for (const nested of [false, true]) {
        await fit();
        /** @type {{ id: string, left: number, onCanvas: boolean, clickable: boolean, distance: number, canvasWidth: number }[]} */
        const groups = await evaluate(`window.__smoke.openGroups()`);
        const candidates = groups
          .filter(
            (candidate) =>
              candidate.onCanvas &&
              candidate.clickable &&
              candidate.distance > 0.2 * candidate.canvasWidth &&
              candidate.id.includes('.') === nested &&
              !(rows && SPANNING.includes(candidate.id)),
          )
          .sort((a, b) => a.left - b.left);
        const [nearest] = candidates;
        if (!nearest)
          throw new Error(`no ${nested ? 'component' : 'domain'} to close by its chevron`);
        const what = `${rowsName}: a ${nested ? 'component' : 'domain'} far from the middle`;
        /** The groups whose closing left the place in the middle where it was. @type {string[]} */
        const untelling = [];
        let group = nearest;
        let chevron = '';
        /** @type {Awaited<ReturnType<typeof watched>> | undefined} */
        let closing;
        /** @type {ReturnType<typeof worstShift> | undefined} */
        let closingCorner;
        /** How far the place in the middle of the canvas moved. @type {Shift | undefined} */
        let closingMiddle;
        for (const candidate of candidates) {
          const id = candidate.id;
          group = candidate;
          chevron = `.react-flow__node[data-id="${id}"] .arch-chevron`;
          const seen = await watched(
            () => click(chevron),
            `window.__smoke.attr('data-collapsed-count') === '1' && window.__smoke.attr('data-arrangement') !== 'full'`,
            `${id} closed by its chevron`,
          );
          const corner = worstShift(seen.change, seen.rest, (before, after) =>
            cornerShift(before, after, id),
          );
          closing = seen;
          closingCorner = corner;
          closingMiddle = seen.change ? placeShift(seen.change.before, seen.rest) : undefined;
          // Where the place in the middle did not move either, the group would have stayed with
          // the middle held as well: it is opened again, and the next one taken.
          if (!(corner.shift <= 2) || !closingMiddle || closingMiddle.shift > 4) break;
          untelling.push(id);
          await click(chevron);
          await until(
            `window.__smoke.attr('data-collapsed-count') === '0' && window.__smoke.attr('data-arrangement') === 'full'`,
            `${id} opened again`,
          );
          await fit();
        }
        if (!closing || !closingCorner) throw new Error('no group was closed');
        const closingMoved = closing.change
          ? othersMoved(closing.change.before, closing.rest, group.id)
          : [];
        check(
          `closed up, ${what}, closed by its chevron, stays where it was on screen while the other boxes close up`,
          group.distance > 0.2 * group.canvasWidth &&
            closingCorner.shift <= 2 &&
            closingMiddle !== undefined &&
            Number.isFinite(closingMiddle.shift) &&
            closingMiddle.shift > 4 &&
            closingMoved.length > 0 &&
            zoomKept(closing.change) &&
            closing.sameCanvas,
          {
            group,
            closingCorner,
            closingMiddle,
            untelling,
            moved: closingMoved.slice(0, 6),
            changes: closing.changes,
          },
        );
        const opening = await watched(
          () => click(chevron),
          `window.__smoke.attr('data-collapsed-count') === '0' && window.__smoke.attr('data-arrangement') === 'full'`,
          `${group.id} opened by its chevron`,
        );
        const openingCorner = worstShift(opening.change, opening.rest, (before, after) =>
          cornerShift(before, after, group.id),
        );
        const openingMoved = opening.change
          ? othersMoved(opening.change.before, opening.rest, group.id)
          : [];
        const openingMiddle = opening.change
          ? placeShift(opening.change.before, opening.rest)
          : undefined;
        // Its corner having stayed both ways, the full map is back where it was.
        const startCorner = closing.change
          ? cornerShift(closing.change.before, opening.rest, group.id)
          : undefined;
        check(
          `closed up, ${what}, opened again by its chevron, stays where it was on screen while the other boxes make room`,
          openingCorner.shift <= 2 &&
            openingMiddle !== undefined &&
            Number.isFinite(openingMiddle.shift) &&
            openingMiddle.shift > 4 &&
            openingMoved.length > 0 &&
            zoomKept(opening.change) &&
            opening.sameCanvas &&
            startCorner !== undefined &&
            startCorner.shift <= 2,
          {
            group: group.id,
            openingCorner,
            openingMiddle,
            startCorner,
            moved: openingMoved.slice(0, 6),
          },
        );
      }
    }

    // Collapse all, Expand all and a pinned level keep the box in the middle where it is: the
    // innermost box under the middle that is drawn before and after (a box that disappears hands
    // over to its group), in every frame, on the same canvas.
    await pinLod('subcomponents');
    await fit();
    await centreOn('storefront.payment');
    for (const [name, act, done] of /** @type {[string, () => Promise<void>, string][]} */ ([
      [
        'Collapse all',
        () => click('#collapse-all'),
        `window.__smoke.attr('data-collapsed-count') !== '0' && window.__smoke.attr('data-arrangement') !== 'full'`,
      ],
      [
        'Expand all',
        () => click('#expand-all'),
        `window.__smoke.attr('data-collapsed-count') === '0' && window.__smoke.attr('data-arrangement') === 'full'`,
      ],
      [
        'a pinned level',
        () => pinLod('components'),
        `window.__smoke.attr('data-lod') === 'components' && window.__smoke.attr('data-arrangement') !== 'full'`,
      ],
    ])) {
      const seen = await watched(act, done, `the map after ${name}`);
      const place = worstShift(seen.change, seen.rest, (before, after) =>
        placeShift(before, after, seen.rest),
      );
      check(
        `closed up: ${name} keeps the box in the middle of the canvas where it was, in every frame, on the same canvas`,
        place.shift <= 2 && zoomKept(seen.change) && seen.sameCanvas,
        { place, changes: seen.changes, sameCanvas: seen.sameCanvas },
      );
    }

    // Auto: a zoom across a level arranges the map for the new level once the view rests, and
    // the box under the middle stays where it was, from the frame of the change on; zooming
    // back brings back the very same arrangement.
    await pinLod('components');
    await fit();
    await centreOn('data.event-store');
    await pinLod('auto', await attr('data-zoom-lod'));
    await zoomToLevel('components');
    await centreOn('data.event-store');
    const atComponents = {
      arrangement: await attr('data-arrangement'),
      boxes: await canvasBoxes(),
    };
    const zoomedIn = await watched(
      () => zoomToLevel('subcomponents'),
      `window.__smoke.attr('data-lod') === 'subcomponents'`,
      'the Subcomponents level drawn',
    );
    const placeIn = worstShift(zoomedIn.change, zoomedIn.rest, (before, after) =>
      placeShift(before, after, zoomedIn.rest),
    );
    check(
      'closed up in Auto: zooming in across a level arranges the map anew once the view rests, the box under the middle staying where it was from the frame of the change on',
      atComponents.arrangement !== 'full' &&
        zoomedIn.change?.after[0]?.arrangement === 'full' &&
        placeIn.id === 'data.event-store' &&
        placeIn.shift <= 2 &&
        zoomKept(zoomedIn.change) &&
        zoomedIn.sameCanvas &&
        (await attr('data-level-settled')) === 'true',
      { placeIn, changes: zoomedIn.changes, arrangement: atComponents.arrangement },
    );
    const zoomedOut = await watched(
      () => zoomToLevel('components'),
      `window.__smoke.attr('data-lod') === 'components'`,
      'the Components level drawn again',
    );
    const placeOut = worstShift(zoomedOut.change, zoomedOut.rest, (before, after) =>
      placeShift(before, after, zoomedOut.rest),
    );
    const movedBack = await movedFrom(atComponents.boxes);
    check(
      'closed up in Auto: zooming back out keeps the box under the middle where it was and brings back the same arrangement, every box where it was',
      placeOut.shift <= 2 &&
        zoomKept(zoomedOut.change) &&
        (await attr('data-arrangement')) === atComponents.arrangement &&
        movedBack.length === 0 &&
        Object.keys(await canvasBoxes()).length === Object.keys(atComponents.boxes).length,
      { placeOut, movedBack: movedBack.slice(0, 6) },
    );

    // Fit view in Auto fits the map as it is drawn at the level the fit ends on: the level is
    // settled and stays, the map fills the canvas, a second fit changes nothing, and the fit
    // button on the canvas does the same. A fresh load without a stored view does so too.
    await showRows(false);
    await zoomToLevel('subcomponents');
    await click('#fit-view');
    const fitSettled = await eventually(
      `window.__smoke.attr('data-level-settled') === 'true'`,
      'the level after the fit',
    );
    await settled();
    const fittedView = await viewNow();
    const fittedLevels = await levelsDuring(500);
    /** @type {string[]} */
    const fittedOff = await evaluate(`window.__smoke.offCanvas()`);
    /** @type {{ width: number, free: number }} */
    const fittedSpread = await evaluate(`window.__smoke.mapSpread()`);
    check(
      'Fit view in Auto, closed up: the level is settled and stays, and the whole map is on the canvas, filling it',
      fitSettled &&
        fittedLevels.length === 1 &&
        fittedLevels[0]?.endsWith(' true') &&
        fittedOff.length === 0 &&
        fittedSpread.width >= 0.4 * fittedSpread.free,
      { fittedLevels, fittedOff, fittedSpread, fittedView },
    );
    await click('#fit-view');
    await settled();
    const refittedView = await viewNow();
    check(
      'Fit view in Auto, closed up: pressing it again leaves the view as it is',
      sameView(fittedView, refittedView),
      { fittedView, refittedView },
    );
    /** Zooms to `level`, presses Fit view once, and gives the view the map then rests at. */
    const fitFrom = async (/** @type {string} */ level) => {
      await zoomToLevel(level);
      await click('#fit-view');
      await until(
        `window.__smoke.attr('data-level-settled') === 'true' && window.__smoke.attr('data-lines-laid-out') === 'true'`,
        `the map fitted from the ${level} level`,
      );
      await settled();
      return viewNow();
    };
    const fittedFromDomains = await fitFrom('domains');
    const fittedFromEverything = await fitFrom('detail');
    check(
      'Fit view in Auto, closed up, without rows: pressed once at the Domains level or at Everything, it gives the same view as at the Subcomponents level',
      sameView(fittedFromDomains, fittedView) && sameView(fittedFromEverything, fittedView),
      { fittedView, fittedFromDomains, fittedFromEverything },
    );
    await zoomToLevel('subcomponents');
    await click('.react-flow__controls-fitview');
    await eventually(
      `window.__smoke.attr('data-level-settled') === 'true'`,
      'the level after the fit of the canvas',
    );
    await settled();
    const canvasFitted = await viewNow();
    check(
      'the fit button on the canvas fits the closed-up map as Fit view does',
      sameView(canvasFitted, fittedView),
      { canvasFitted, fittedView },
    );
    await evaluate(
      `Object.keys(localStorage).filter((key) => key.startsWith('architecture-map.viewport:')).forEach((key) => localStorage.removeItem(key))`,
    );
    await reloadWith('');
    const loadSettled = await eventually(
      `window.__smoke.attr('data-level-settled') === 'true'`,
      'the level after the load',
    );
    await settled();
    const loadLevels = await levelsDuring(500);
    /** @type {string[]} */
    const loadOff = await evaluate(`window.__smoke.offCanvas()`);
    check(
      'a fresh load in Auto, closed up and without a stored view, shows the whole map at a settled level that stays',
      loadSettled &&
        (await attr('data-close-gaps')) === 'true' &&
        (await attr('data-lod-mode')) === 'auto' &&
        loadLevels.length === 1 &&
        loadOff.length === 0,
      { loadLevels, loadOff },
    );
    await showRows(true);
    const rowsFromEverything = await fitFrom('detail');
    await click('#fit-view');
    await settled();
    const rowsAgain = await viewNow();
    const rowsFromDomains = await fitFrom('domains');
    check(
      'Fit view in Auto, closed up, with rows: pressed once at Everything it gives the view a second press leaves, and the same as at the Domains level',
      sameView(rowsFromEverything, rowsAgain) && sameView(rowsFromDomains, rowsAgain),
      { rowsFromEverything, rowsAgain, rowsFromDomains },
    );

    // Going somewhere from the Domains level in Auto: the box, the edge, the work item end on
    // screen and drawn, and the level is settled once the move is over and stays.
    /** Waits for `drawn` after a move and the view at rest; then whether the level stays. */
    const arrived = async (/** @type {string} */ drawn, /** @type {string} */ what) => {
      const reached = await eventually(
        `window.__smoke.attr('data-level-settled') === 'true' && ${drawn}`,
        what,
      );
      await settled();
      const levels = await levelsDuring(500);
      return { reached, levels, steady: levels.length === 1 && !!levels[0]?.endsWith(' true') };
    };
    await zoomToLevel('domains');
    // Ctrl+K: the focus is on a checkbox, where "/" does not reach the search box.
    await openSearch('k');
    await client.send('Input.insertText', { text: 'iphone' });
    await until(`window.__smoke.count('#search-results [role="option"]') > 0`, 'search results');
    await press('Enter', { keyCode: 13, text: '\r' });
    await untilSelection('node:storefront.apps.ios');
    const toNode = await arrived(
      `window.__smoke.count('.react-flow__node[data-id="storefront.apps.ios"]') === 1`,
      'the subcomponent drawn',
    );
    check(
      'closed up in Auto at the Domains level: a subcomponent gone to from the search ends drawn and wholly on screen, at a settled level',
      toNode.reached &&
        toNode.steady &&
        (await evaluate(
          `window.__smoke.onScreen('.react-flow__node[data-id="storefront.apps.ios"]')`,
        )) === true,
      toNode,
    );
    await openSearch('k');
    await client.send('Input.insertText', { text: 'storefront.gateway.buffer' });
    await until(`window.__smoke.count('#search-results [role="option"]') > 0`, 'search results');
    await press('Enter', { keyCode: 13, text: '\r' });
    await untilSelection('node:storefront.gateway.buffer');
    await settled();
    await zoomToLevel('domains');
    await click('#detail-outgoing [data-edge-id="buffer-to-broker"]');
    await untilSelection('edge:buffer-to-broker');
    const toEdge = await arrived(
      `window.__smoke.count('.react-flow__node[data-id="storefront.gateway.buffer"]') === 1 && window.__smoke.count('.react-flow__node[data-id="data.ingest.broker"]') === 1 && window.__smoke.count('.react-flow__edge.selected') === 1`,
      'the edge drawn',
    );
    check(
      'closed up in Auto at the Domains level: an edge gone to from the node panel ends drawn, its source on screen, at a settled level',
      toEdge.reached &&
        toEdge.steady &&
        (await evaluate(
          `window.__smoke.onScreen('.react-flow__node[data-id="storefront.gateway.buffer"]')`,
        )) === true,
      toEdge,
    );
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await zoomToLevel('domains');
    await openSearch('k');
    await client.send('Input.insertText', { text: '#1010' });
    await until(
      `window.__smoke.count('#search-results [data-workitem-id="1010"]') === 1`,
      'the story among the search results',
    );
    await press('Enter', { keyCode: 13, text: '\r' });
    await untilSelection('workitem:1010');
    const toStory = await arrived(
      `window.__smoke.attr('data-lod') === 'detail' && window.__smoke.attr('data-lines-laid-out') === 'true' && window.__smoke.count('.arch-workitem-selected[data-workitem-id="1010"]') === 1`,
      'the line of the story drawn',
    );
    check(
      'closed up in Auto at the Domains level: a story gone to from the search ends with the lists drawn and its line on screen, at a settled level',
      toStory.reached &&
        toStory.steady &&
        (await evaluate(`window.__smoke.onScreen('.arch-workitem[data-workitem-id="1010"]')`)) ===
          true,
      toStory,
    );
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);

    // Filter, closed up, with rows and without: the filtered map arrives fitted (with every group
    // of it open), nothing overlaps, it closes up at a coarser level, and leaving Filter comes
    // back to the box that was in the middle.
    for (const rows of [true, false]) {
      const rowsName = rows ? 'with rows' : 'without rows';
      await showRows(rows);
      if ((await attr('data-focus-mode')) !== 'filter') {
        await click('#focus-mode');
        await until(`window.__smoke.attr('data-focus-mode') === 'filter'`, 'Filter mode');
      }
      await pinLod('components');
      await fit();
      await centreOn('data.event-store');
      const beforeFilter = await frame();
      await chooseOption('#focus-select', flowFocus);
      await untilFiltered(flowFocus);
      const filteredFit = await fitOnScreen();
      const filteredProblems = await layoutProblems();
      const filteredSize = await attr('data-layout-size');
      check(
        `closed up, ${rowsName}: the map filtered to a flow arrives fitted, with no box over another`,
        filteredFit.fitted && filteredProblems.length === 0,
        { ...filteredFit, filteredProblems },
      );
      await pinLod('components');
      const coarser = {
        arrangement: await attr('data-arrangement'),
        size: await attr('data-layout-size'),
        problems: await layoutProblems(),
      };
      check(
        `closed up, ${rowsName}: the filtered map at the Components level is closed up, smaller, with no box over another`,
        coarser.arrangement !== 'full' &&
          areaOf(coarser.size) < areaOf(filteredSize) &&
          coarser.problems.length === 0,
        { ...coarser, filteredSize },
      );
      // The panel of the flow closed first: the canvas is as wide as before Filter.
      await press('Escape', { keyCode: 27 });
      await untilSelection(null);
      await click('#focus-clear');
      await until(`window.__smoke.attr('data-focus') === null`, 'the focus cleared');
      await untilFiltered(null);
      const back = placeShift(beforeFilter, await frame());
      check(
        `closed up, ${rowsName}: leaving Filter comes back to the box that was in the middle before`,
        back.id === 'data.event-store' && back.shift <= 2,
        back,
      );
    }
    if ((await attr('data-focus-mode')) !== closeUpStart.focusMode) {
      await click('#focus-mode');
      await until(
        `window.__smoke.attr('data-focus-mode') === '${closeUpStart.focusMode}'`,
        'Focus mode as before',
      );
    }

    // Positions moved by hand belong to one arrangement: a box moved on the closed-up map stays
    // where it was dropped across a change of level and back, Reset positions puts it back, and
    // a box moved on the full map is still moved there, whether the option is on or off.
    await showRows(true);
    await pinLod('components');
    await fit();
    const boxOf = async (/** @type {string} */ id) => (await canvasBoxes())[id];
    /** A point of the header of the group `id` to grab it by: at its right end, clear of its name. */
    const headerGrip = (/** @type {string} */ id) =>
      evaluate(`(() => {
        const r = document.querySelector('.react-flow__node[data-id="${id}"] .arch-group-header').getBoundingClientRect();
        return { x: r.right - 12, y: r.top + r.height / 2 };
      })()`);
    /** Drags the group `id` by its header, and waits until it counts as moved. */
    const dragGroup = async (/** @type {string} */ id) => {
      const grip = await headerGrip(id);
      await drag(grip, { x: grip.x + 90, y: grip.y + 60 });
      await until(`window.__smoke.attr('data-moved-count') === '1'`, `${id} moved by hand`);
      await settled();
    };
    const arrangedAt = await boxOf('backoffice');
    await click('#unlock-positions');
    await until(`window.__smoke.attr('data-positions-unlocked') === 'true'`, 'unlocked positions');
    await dragGroup('backoffice');
    const droppedAt = await boxOf('backoffice');
    await pinLod('subcomponents');
    const movedOnFull = await attr('data-moved-count');
    await pinLod('components');
    const comeBackAt = await boxOf('backoffice');
    check(
      'closed up: a box moved by hand stays where it was dropped when the level changes and comes back, and the full map does not count it',
      !!arrangedAt &&
        !!droppedAt &&
        (droppedAt[0] ?? NaN) > (arrangedAt[0] ?? NaN) + 20 &&
        sameBox(comeBackAt, droppedAt) &&
        movedOnFull === '0' &&
        (await attr('data-moved-count')) === '1',
      { arrangedAt, droppedAt, comeBackAt, movedOnFull },
    );
    await click('#reset-positions');
    await until(`window.__smoke.attr('data-moved-count') === '0'`, 'positions reset');
    await settled();
    const resetAt = await boxOf('backoffice');
    check(
      'closed up: Reset positions puts the box back where the closed-up map has it',
      sameBox(resetAt, arrangedAt),
      { resetAt, arrangedAt },
    );
    await pinLod('subcomponents');
    await fit();
    const fullAt = await boxOf('backoffice');
    await dragGroup('backoffice');
    const fullDropped = await boxOf('backoffice');
    await pinLod('components');
    const movedClosedUp = await attr('data-moved-count');
    await pinLod('subcomponents');
    const fullBack = await boxOf('backoffice');
    await closeUp(false);
    const fullOff = await boxOf('backoffice');
    const movedOff = await attr('data-moved-count');
    await closeUp(true);
    check(
      'a box moved on the full map is still moved there, with Close up the gaps on and off, and not on the closed-up map',
      !!fullAt &&
        !sameBox(fullDropped, fullAt) &&
        movedClosedUp === '0' &&
        sameBox(fullBack, fullDropped) &&
        sameBox(fullOff, fullDropped) &&
        movedOff === '1',
      { fullAt, fullDropped, fullBack, fullOff, movedClosedUp, movedOff },
    );
    await click('#reset-positions');
    await until(`window.__smoke.attr('data-moved-count') === '0'`, 'positions reset again');
    await click('#unlock-positions');
    await until(`window.__smoke.attr('data-positions-unlocked') === 'false'`, 'locked positions');

    // Saved views and links remember the option, and their place is one of the closed-up map:
    // applied with the option off, the option is on again and the same box is in the middle. A
    // view without the flag switches it off.
    const CLOSED_VIEW = 'Closed up';
    await pinLod('components');
    await fit();
    await centreOn('data.event-store');
    const viewFrame = await frame();
    await saveView(CLOSED_VIEW);
    await until(
      `window.__smoke.count('#views-list li[data-view-name="${CLOSED_VIEW}"]') === 1`,
      'the closed-up view saved',
    );
    await evaluate(`document.querySelector('#copy-view-link').click()`);
    await until(`window.location.hash.startsWith('#view=')`, 'the link in the address bar');
    /** @type {string} */
    const closedHash = await evaluate(`window.location.hash`);
    await closeUp(false);
    await evaluate(
      `document.querySelector('#views-list li[data-view-name="${CLOSED_VIEW}"] .views-apply').click()`,
    );
    await until(
      `window.__smoke.attr('data-close-gaps') === 'true' && window.__smoke.attr('data-arrangement') === ${JSON.stringify(viewFrame.arrangement)}`,
      'the closed-up view applied',
    );
    await settled();
    const appliedBack = placeShift(viewFrame, await frame());
    check(
      'a view saved closed up, applied with the option off, switches it on with the same box in the middle',
      appliedBack.id === 'data.event-store' && appliedBack.shift <= 2,
      appliedBack,
    );
    await closeUp(false);
    await reloadWith(closedHash);
    await until(
      `window.__smoke.attr('data-close-gaps') === 'true' && window.__smoke.attr('data-arrangement') === ${JSON.stringify(viewFrame.arrangement)}`,
      'the closed-up link applied',
    );
    await settled();
    const linkBack = placeShift(viewFrame, await frame());
    check(
      'a link copied closed up opens the map closed up with the same box in the middle',
      linkBack.id === 'data.event-store' && linkBack.shift <= 2,
      linkBack,
    );
    const linked = JSON.parse(
      Buffer.from(closedHash.slice('#view='.length), 'base64url').toString('utf8'),
    );
    const { closeGaps: linkedFlag, ...older } = linked;
    await reloadWith(linkOf(older));
    const olderOff = await eventually(
      `window.__smoke.attr('data-close-gaps') === 'false' && window.__smoke.attr('data-lod-mode') === ${JSON.stringify(linked.lodMode)}`,
      'the link without the flag applied',
    );
    check(
      'a view without the flag switches Close up the gaps off',
      linkedFlag === true && olderOff,
      { linkedFlag, closeGaps: await attr('data-close-gaps') },
    );
    // Leave no trace: the fragment would apply the view on every load.
    await reloadWith('');
    await evaluate(
      `document.querySelector('#views-list li[data-view-name="${CLOSED_VIEW}"] .views-delete').click()`,
    );
    await until(
      `window.__smoke.count('#views-list li[data-view-name="${CLOSED_VIEW}"]') === 0`,
      'the closed-up view deleted',
    );

    // The Everything level in Auto with two domains closed by hand: the lists are drawn, the
    // closed domains stay shrunk and the map closed up, nothing overlaps, and nothing failed in
    // the page.
    await closeUp(true);
    await pinLod('components');
    await fit();
    await pinLod('auto', await attr('data-zoom-lod'));
    await zoomToLevel('components');
    for (const [i, id] of ['backoffice', 'platform'].entries()) {
      await centreOn(id);
      await click(`.react-flow__node[data-id="${id}"] .arch-chevron`);
      await until(`window.__smoke.attr('data-collapsed-count') === '${i + 1}'`, `${id} closed`);
      await settled();
    }
    await centreOn('data.event-store');
    await zoomToLevel('detail');
    const everything = {
      lines: await countOf('.arch-workitem'),
      shrunk: await countOf(
        '.react-flow__node[data-id="backoffice"] .arch-compact, .react-flow__node[data-id="platform"] .arch-compact',
      ),
      arrangement: await attr('data-arrangement'),
      problems: await layoutProblems(),
    };
    check(
      'closed up at the Everything level with two domains closed by hand: the lists are drawn, the two stay shrunk, the map closed up, no box over another',
      everything.lines > 0 &&
        everything.shrunk === 2 &&
        typeof everything.arrangement === 'string' &&
        everything.arrangement !== 'full' &&
        everything.problems.length === 0,
      everything,
    );

    // Nothing selected from here on: the canvas keeps its width across a reload.
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    /**
     * The box drawn in both frames that moved furthest on screen, and how many boxes only one of
     * the frames draws.
     * @param {Frame} before @param {Frame} after
     */
    const largestMove = (before, after) => {
      /** @type {{ id: string | null, shift: number }} */
      let worst = { id: null, shift: 0 };
      for (const id of Object.keys(before.boxes)) {
        if (after.boxes[id] === undefined) continue;
        const { shift } = cornerShift(before, after, id);
        if (!(shift <= worst.shift)) worst = { id, shift };
      }
      const both = Object.keys(before.boxes).filter((id) => after.boxes[id] !== undefined).length;
      return {
        ...worst,
        both,
        onlyOne: Object.keys(before.boxes).length + Object.keys(after.boxes).length - 2 * both,
      };
    };

    // Another story mode lays the map out again. With groups closed by hand at the Everything
    // level, the box in the middle of the canvas stays where it was, there and back.
    await pinLod('detail');
    await fit();
    await closeByHand(['storefront', 'data.analytics', 'operations.console']);
    await fit();
    await centreOn('data.analytics');
    const storiesBefore = await attr('data-story-mode');
    const storiesOther = storiesBefore === 'tasks' ? 'stories' : 'tasks';
    /** Chooses the story mode and waits for the map laid out for it, at rest. */
    const laidOutFor = async (/** @type {string} */ mode) => {
      await chooseStories(mode);
      await until(
        `window.__smoke.attr('data-lines-laid-out') === 'true' && window.__smoke.attr('data-layout-pending') === 'false'`,
        `the map laid out for the story mode ${mode}`,
      );
      await settled();
      return frame();
    };
    const closedFrame = await frame();
    const otherFrame = await laidOutFor(storiesOther);
    const placeOther = placeShift(closedFrame, otherFrame);
    const backFrame = await laidOutFor(String(storiesBefore));
    const placeBack = placeShift(otherFrame, backFrame);
    check(
      'closed up at the Everything level with three groups closed by hand: another story mode, and the first one again, keep the box in the middle of the canvas where it was',
      storiesBefore !== 'off' &&
        closedFrame.arrangement !== 'full' &&
        placeOther.id === 'data.analytics' &&
        placeOther.shift <= 2 &&
        placeBack.id === 'data.analytics' &&
        placeBack.shift <= 2 &&
        largestMove(closedFrame, backFrame).shift <= 2,
      { placeOther, placeBack, back: largestMove(closedFrame, backFrame) },
    );

    // In Auto the level drawn waits for the view to rest. While a gesture lasts — here the
    // canvas held with the mouse while the wheel zooms from the Domains level to Everything —
    // the map stays as it is, on the layout without the lists, and the Detail tab and its mark
    // on the rail show the level that is to come. Let go, that level is drawn.
    await pinLod('auto', await attr('data-zoom-lod'));
    await zoomToLevel('domains');
    const heldAt = await evaluate(`window.__smoke.panPlan(8, 6)`);
    const wheelAt = await evaluate(`window.__smoke.canvasMiddle()`);
    if (heldAt === null) throw new Error('no empty canvas to hold');
    const heldMark = await markCanvas();
    const heldSize = await attr('data-layout-size');
    await drag(heldAt.from, heldAt.to, { hold: true });
    for (let turn = 0; turn < 24 && (await attr('data-zoom-lod')) !== 'detail'; turn++) {
      const { zoom } = await viewNow();
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: wheelAt.x,
        y: wheelAt.y,
        deltaX: 0,
        deltaY: -200,
      });
      await until(`window.__smoke.viewport().zoom > ${zoom}`, 'the zoom after a wheel turn');
    }
    const toComeShown = await eventually(
      `window.__smoke.attr('data-zoom-lod') === 'detail' && document.querySelector('#lod-indicator')?.dataset.lodPending === 'detail' && window.__smoke.count('#lod-indicator .lod-step-pending[data-lod-option="detail"]') === 1 && window.__smoke.count('#tab-detail .cp-tab-mark-pending') === 1`,
      'the level to come shown on the Detail tab and on the rail',
    );
    // Longer than the level and the lists wait for a view at rest.
    const levelsHeld = await levelsDuring(900);
    const held = {
      size: await attr('data-layout-size'),
      sameCanvas: await sameCanvas(heldMark),
      lists: await countOf('.arch-workitem'),
    };
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: heldAt.to.x,
      y: heldAt.to.y,
      button: 'left',
      clickCount: 1,
    });
    const letGo = await eventually(
      `window.__smoke.attr('data-lod') === 'detail' && window.__smoke.attr('data-level-settled') === 'true' && window.__smoke.attr('data-lines-laid-out') === 'true' && window.__smoke.count('.arch-workitem') > 0`,
      'the Everything level drawn with its lists',
    );
    await settled();
    const toComeAfter =
      (await countOf('#lod-indicator[data-lod-pending]')) +
      (await countOf('.lod-step-pending')) +
      (await countOf('.cp-tab-mark-pending'));
    check(
      'closed up in Auto: while the canvas is held and the wheel zooms from the Domains level to Everything, the map stays as it is and the Detail tab and the rail show the level to come; let go, that level is drawn with its lists',
      toComeShown &&
        levelsHeld.length === 1 &&
        levelsHeld[0] === 'domains false' &&
        held.size === heldSize &&
        held.sameCanvas &&
        held.lists === 0 &&
        letGo &&
        toComeAfter === 0,
      { toComeShown, levelsHeld, heldSize, held, letGo, toComeAfter },
    );

    // The Everything level is laid out with the work-item lists. A view left there comes back
    // at the very same place: after a reload, from a saved view and from a link — the first
    // time each. And after a reload with the option off.
    const EVERYTHING_VIEW = 'At Everything';
    /** Waits for the Everything level drawn by the zoom, with its lists, at rest: the frame. */
    const atEverything = async (/** @type {string} */ what) => {
      await until(
        `window.__smoke.attr('data-lod-mode') === 'auto' && window.__smoke.attr('data-lod') === 'detail' && window.__smoke.attr('data-level-settled') === 'true' && window.__smoke.attr('data-lines-laid-out') === 'true'`,
        what,
      );
      await settled();
      return frame();
    };
    await until(viewIsStored, 'the view at Everything kept in the browser');
    const everythingFrame = await frame();
    await reloadWith('');
    const everythingReloaded = largestMove(
      everythingFrame,
      await atEverything('the Everything level after the reload'),
    );
    await saveView(EVERYTHING_VIEW);
    await until(
      `window.__smoke.count('#views-list li[data-view-name="${EVERYTHING_VIEW}"]') === 1`,
      'the view at Everything saved',
    );
    await evaluate(`document.querySelector('#copy-view-link').click()`);
    await until(`window.location.hash.startsWith('#view=')`, 'the link in the address bar');
    /** @type {string} */
    const everythingHash = await evaluate(`window.location.hash`);
    await fitFrom('detail');
    await evaluate(
      `document.querySelector('#views-list li[data-view-name="${EVERYTHING_VIEW}"] .views-apply').click()`,
    );
    const everythingApplied = largestMove(
      everythingFrame,
      await atEverything('the view at Everything applied'),
    );
    await fitFrom('detail');
    await reloadWith(everythingHash);
    const everythingLinked = largestMove(
      everythingFrame,
      await atEverything('the link at Everything opened'),
    );
    // Leave no trace: the fragment would apply the view on every load.
    await until(viewIsStored, 'the view of the link kept in the browser');
    await reloadWith('');
    await evaluate(
      `document.querySelector('#views-list li[data-view-name="${EVERYTHING_VIEW}"] .views-delete').click()`,
    );
    await until(
      `window.__smoke.count('#views-list li[data-view-name="${EVERYTHING_VIEW}"]') === 0`,
      'the view at Everything deleted',
    );
    const boxesAtEverything = Object.keys(everythingFrame.boxes).length;
    check(
      'closed up in Auto at the Everything level: a reload, a saved view and a link each show every box where it was, the first time',
      everythingFrame.lod === 'detail' &&
        [everythingReloaded, everythingApplied, everythingLinked].every(
          (moved) => moved.shift <= 2 && moved.both === boxesAtEverything && moved.onlyOne === 0,
        ),
      { boxes: boxesAtEverything, everythingReloaded, everythingApplied, everythingLinked },
    );
    await closeUp(false);
    await atEverything('the Everything level on the full map');
    await until(viewIsStored, 'the view at Everything on the full map kept in the browser');
    const fullFrame = await frame();
    await reloadWith('');
    const fullReloaded = largestMove(
      fullFrame,
      await atEverything('the Everything level on the full map after the reload'),
    );
    check(
      'in Auto at the Everything level with Close up the gaps off: a reload shows every box where it was',
      fullFrame.lod === 'detail' &&
        fullReloaded.shift <= 2 &&
        fullReloaded.both === Object.keys(fullFrame.boxes).length &&
        fullReloaded.onlyOne === 0,
      fullReloaded,
    );
    await closeUp(true);

    // A reload comes back in Auto. A view left with a level pinned and zoomed in is then drawn
    // at the level its zoom selects — another arrangement — and shows the same place.
    await pinLod('domains');
    await fit();
    const zoomAt = await evaluate(`window.__smoke.canvasMiddle()`);
    for (let turn = 0; turn < 12 && (await attr('data-zoom-lod')) !== 'subcomponents'; turn++) {
      const { zoom } = await viewNow();
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: zoomAt.x + 250,
        y: zoomAt.y + 60,
        deltaX: 0,
        deltaY: -100,
      });
      await until(`window.__smoke.viewport().zoom > ${zoom}`, 'the zoom after a wheel turn');
    }
    await settled();
    await until(viewIsStored, 'the view at the pinned level kept in the browser');
    const pinnedFrame = await frame();
    const pinnedZoomLevel = await attr('data-zoom-lod');
    await reloadWith('');
    await until(
      `window.__smoke.attr('data-lod-mode') === 'auto' && window.__smoke.attr('data-level-settled') === 'true' && window.__smoke.attr('data-lines-laid-out') === 'true'`,
      'the level after the reload',
    );
    await settled();
    const unpinnedFrame = await frame();
    const pinnedPlace = placeShift(pinnedFrame, unpinnedFrame);
    check(
      'closed up, a view left zoomed in with the Domains level pinned: a reload draws the level of its zoom, and the place in the middle of the canvas is the same',
      pinnedFrame.lod === 'domains' &&
        pinnedZoomLevel === 'subcomponents' &&
        unpinnedFrame.lod === 'subcomponents' &&
        unpinnedFrame.arrangement !== pinnedFrame.arrangement &&
        Math.abs((unpinnedFrame.zoom ?? NaN) - (pinnedFrame.zoom ?? NaN)) < 0.001 &&
        pinnedPlace.id !== null &&
        pinnedPlace.shift <= 2,
      {
        pinnedPlace,
        pinned: [pinnedFrame.lod, pinnedFrame.arrangement, pinnedZoomLevel],
        reloaded: [unpinnedFrame.lod, unpinnedFrame.arrangement],
      },
    );
    check(
      'nothing failed in the page while the map was closed up',
      pageErrors.length === 0,
      pageErrors.slice(0, 5),
    );

    // Back to the state the block started from.
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await closeUp(false);
    await setSetting('compact-collapsed', closeUpStart.shrink === 'true');
    await showRows(closeUpStart.rows === 'true');
    await evaluate(
      `document.querySelector('#views-list li[data-view-name="${START_VIEW}"] .views-apply').click()`,
    );
    await until(
      `window.__smoke.attr('data-lod-mode') === ${JSON.stringify(closeUpStart.lodMode)} && window.__smoke.attr('data-collapsed-count') === ${JSON.stringify(closeUpStart.collapsed)} && window.__smoke.attr('data-lines-laid-out') === 'true'`,
      'the view the block started from',
    );
    await settled();
    await evaluate(
      `document.querySelector('#views-list li[data-view-name="${START_VIEW}"] .views-delete').click()`,
    );
    await until(
      `window.__smoke.count('#views-list li[data-view-name="${START_VIEW}"]') === 0`,
      'the view to come back to deleted',
    );
    if ((await attr('data-panel-tab')) !== closeUpStart.tab) {
      await click(`#tab-${closeUpStart.tab}`);
      await until(
        `window.__smoke.attr('data-panel-tab') === '${closeUpStart.tab}'`,
        'the tab shown before',
      );
    }
    if ((await attr('data-panel-collapsed')) !== closeUpStart.panelCollapsed) {
      await togglePanel(closeUpStart.panelCollapsed === 'true');
    }

    // --- Boxes set by hand: open groups moved by the title bar and resized at their edges ------
    {
      /** @typedef {{ x: number, y: number }} HandPoint */
      /** @typedef {Record<string, number[]>} ScreenRects left, top, right, bottom by node ID */
      /** @typedef {{ x: number, y: number, zoom: number }} HandView */
      /** @typedef {{ from: HandPoint, to: HandPoint, before: ScreenRects, view: HandView }} HandGesture */
      /** @typedef {{ id: string, kind: string, name: string | null, controls: string[], grip: { tag: string, label: string | null } | null }} DrawnNode */
      /** @typedef {{ titleDrag: boolean, wrapper: string, header: string | null, headerCursor: string | null, boxCursor: string | null }} PointerRules */
      /** @typedef {{ id: string, heat: number, all: number | null, height: number, title: string }} HeatStrip */
      /** @typedef {{ id: string, done: number, total: number, doneAll: number | null, totalAll: number | null, title: string }} ProgressBar */
      /** @typedef {{ id: string, d: string, ends: number[][] }} EdgeEnds */

      const handStart = {
        tab: await attr('data-panel-tab'),
        panelCollapsed: await attr('data-panel-collapsed'),
        rows: await attr('data-show-rows'),
        shrink: await attr('data-compact-collapsed'),
        closeGaps: await attr('data-close-gaps'),
        focusMode: await attr('data-focus-mode'),
        lodMode: await attr('data-lod-mode'),
        collapsed: await attr('data-collapsed-count'),
        heat: await attr('data-heat'),
        progress: await attr('data-progress'),
        violations: violations.length,
        errors: pageErrors.length,
      };
      const HAND_VIEW = 'Before the changes by hand';
      await press('Escape', { keyCode: 27 });
      await untilSelection(null);
      await saveView(HAND_VIEW);
      await until(
        `window.__smoke.count('#views-list li[data-view-name="${HAND_VIEW}"]') === 1`,
        'the view to come back to',
      );

      const nodeOf = (/** @type {string} */ id) => `.react-flow__node[data-id="${id}"]`;
      /** The ID of the group a node lies in. */
      const parentOf = (/** @type {string} */ id) => id.slice(0, id.lastIndexOf('.'));
      const rects = () => /** @type {Promise<ScreenRects>} */ (evaluate(`window.__smoke.rects()`));
      const drawnNodes = () =>
        /** @type {Promise<DrawnNode[]>} */ (evaluate(`window.__smoke.resizeHandles()`));
      const rulesOf = (/** @type {string} */ id) =>
        /** @type {Promise<PointerRules | null>} */ (
          evaluate(`window.__smoke.pointerRules(${JSON.stringify(id)})`)
        );
      const frames = () => evaluate(`window.__smoke.frames()`);
      /** One side of a box on screen: 0 left, 1 top, 2 right, 3 bottom. */
      const sideOf = (
        /** @type {ScreenRects} */ all,
        /** @type {string} */ id,
        /** @type {number} */ index,
      ) => all[id]?.[index] ?? NaN;
      /** Whether two lists of numbers are the same within `slack`. */
      const sameNumbers = (
        /** @type {number[] | undefined} */ a,
        /** @type {number[] | undefined} */ b,
        slack = 1,
      ) =>
        !!a &&
        !!b &&
        a.length === b.length &&
        a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) <= slack);
      /** The nodes among `ids` whose box on screen is not the same in both. */
      const shifted = (
        /** @type {ScreenRects} */ before,
        /** @type {ScreenRects} */ after,
        /** @type {string[]} */ ids,
      ) => ids.filter((id) => !sameNumbers(before[id], after[id]));
      /** How far each edge of a box moved outwards between two states: left, top, right, bottom. */
      const grownBy = (
        /** @type {ScreenRects} */ before,
        /** @type {ScreenRects} */ after,
        /** @type {string} */ id,
      ) => [
        sideOf(before, id, 0) - sideOf(after, id, 0),
        sideOf(before, id, 1) - sideOf(after, id, 1),
        sideOf(after, id, 2) - sideOf(before, id, 2),
        sideOf(after, id, 3) - sideOf(before, id, 3),
      ];
      /** Every node drawn but `id`; with `inside`, only those in it — otherwise all but those. */
      const others = (
        /** @type {ScreenRects} */ all,
        /** @type {string} */ id,
        /** @type {boolean} */ inside,
      ) =>
        Object.keys(all).filter((other) => other !== id && other.startsWith(`${id}.`) === inside);
      const movedCount = () => /** @type {Promise<string | null>} */ (attr('data-moved-count'));
      const resizedCount = () => /** @type {Promise<string | null>} */ (attr('data-resized-count'));
      /** Whether the counts of what is set by hand come to be these. */
      const counted = (/** @type {number} */ moved, /** @type {number} */ resized) =>
        eventually(
          `window.__smoke.attr('data-moved-count') === '${moved}' && window.__smoke.attr('data-resized-count') === '${resized}'`,
          `${moved} moved and ${resized} resized`,
        );
      const stored = () =>
        /** @type {Promise<string>} */ (evaluate(`JSON.stringify(window.__smoke.byHandStored())`));
      /** Whether what the browser keeps of the changes by hand comes to differ from `from`. */
      const storedChanges = (/** @type {string} */ from) =>
        eventually(
          `JSON.stringify(window.__smoke.byHandStored()) !== ${JSON.stringify(from)}`,
          'what is kept of the changes by hand',
        );
      const unlock = async (/** @type {boolean} */ on) => {
        if ((await attr('data-positions-unlocked')) !== String(on))
          await click('#unlock-positions');
        await until(
          `window.__smoke.attr('data-positions-unlocked') === '${on}'`,
          on ? 'unlocked positions' : 'locked positions',
        );
      };
      /** Switches from Focus to Filter: the map is reduced to what a focus involves. */
      const filterMode = async () => {
        if ((await attr('data-focus-mode')) !== 'filter') await click('#focus-mode');
        await until(`window.__smoke.attr('data-focus-mode') === 'filter'`, 'Filter mode');
      };
      /** Puts back every box moved or resized by hand in the arrangement on screen. */
      const resetByHand = async () => {
        if ((await movedCount()) !== '0' || (await resizedCount()) !== '0') {
          await click('#reset-positions');
        }
        await until(
          `window.__smoke.attr('data-moved-count') === '0' && window.__smoke.attr('data-resized-count') === '0'`,
          'nothing set by hand',
        );
        await settled();
      };
      /**
       * A point of the element to press (`pressPoint`), with room on the canvas for a drag by
       * `by`: the view is panned first when the element lies off the canvas or under something
       * that lies over the canvas' border (it is brought towards the middle), and when the drop
       * would lie outside the canvas. Null when nothing of the element can be pressed.
       * @param {string} selector @param {HandPoint} by @param {string} [avoid]
       * @returns {Promise<HandPoint | null>}
       */
      const pointWithRoom = async (selector, by, avoid = '') => {
        const find = `window.__smoke.pressPoint(${JSON.stringify(selector)}, ${JSON.stringify(avoid)})`;
        let broughtNear = false;
        for (let turn = 0; turn < 5; turn++) {
          /** @type {HandPoint | null} */
          const point = await evaluate(find);
          /** @type {{ dx: number, dy: number } | null} */
          let shift;
          if (point === null) {
            if (broughtNear) return null;
            broughtNear = true;
            const offset = await evaluate(
              `window.__smoke.centreOffset(${JSON.stringify(selector)})`,
            );
            if (offset === null) return null;
            shift = { dx: -offset.dx, dy: -offset.dy };
          } else {
            shift = await evaluate(
              `window.__smoke.roomShift(${point.x + by.x}, ${point.y + by.y})`,
            );
            if (shift === null || (shift.dx === 0 && shift.dy === 0)) return point;
          }
          const plan = await evaluate(`window.__smoke.panPlan(${shift.dx}, ${shift.dy})`);
          if (plan === null) break;
          await drag(plan.from, plan.to);
          await settled();
        }
        throw new Error(`no room on the canvas for a drag from ${selector}`);
      };
      /**
       * Drags an element by `by` screen pixels from a point where a press reaches it, never from
       * a chevron: where it was pressed and let go, and the boxes on screen and the view just
       * before. Null when no point of the element can be pressed.
       * @param {string} selector @param {HandPoint} by @param {{ hold?: boolean }} [options]
       * @returns {Promise<HandGesture | null>}
       */
      const dragFrom = async (selector, by, options = {}) => {
        const from = await pointWithRoom(selector, by, '.arch-chevron');
        if (from === null) return null;
        const before = await rects();
        /** @type {HandView} */
        const view = await viewNow();
        const to = { x: from.x + by.x, y: from.y + by.y };
        await drag(from, to, options);
        return { from, to, before, view };
      };
      /**
       * Drags a resize control of the group — `line.right`, `handle.top.left`, … — by `by` screen
       * pixels (see `dragFrom`).
       * @param {string} id @param {string} which @param {HandPoint} by @param {{ hold?: boolean }} [options]
       */
      const dragControl = (id, which, by, options = {}) =>
        dragFrom(`${nodeOf(id)} .arch-resize.${which}`, by, options);
      /** Lets go of the button held by a drag. */
      const release = (/** @type {HandPoint} */ point) =>
        client.send('Input.dispatchMouseEvent', {
          x: point.x,
          y: point.y,
          button: 'left',
          type: 'mouseReleased',
          clickCount: 1,
        });
      /** Two clicks at the same point, as a double-click arrives. */
      const doubleClickAt = async (/** @type {HandPoint} */ point) => {
        const base = { x: point.x, y: point.y, button: 'left' };
        await client.send('Input.dispatchMouseEvent', {
          ...base,
          type: 'mouseMoved',
          button: 'none',
        });
        for (const clickCount of [1, 2]) {
          await client.send('Input.dispatchMouseEvent', {
            ...base,
            type: 'mousePressed',
            clickCount,
          });
          await client.send('Input.dispatchMouseEvent', {
            ...base,
            type: 'mouseReleased',
            clickCount,
          });
        }
      };
      /** A drag of a box is counted from its second step on: it moves the box by a little less. */
      const movedByDrag = (/** @type {number} */ moved, /** @type {number} */ dragged) =>
        Math.abs(moved) > Math.abs(dragged) * 0.6 &&
        Math.abs(moved) <= Math.abs(dragged) + 3 &&
        Math.sign(moved) === Math.sign(dragged);

      // The full map with rows, every group open, the Components level pinned: the domains are
      // drawn open, the components in them closed. The Layout tab stays open from here, so the
      // canvas keeps its width.
      await showControl('#unlock-positions');
      await closeUp(false);
      await setSetting('compact-collapsed', false);
      await until(`window.__smoke.attr('data-compact-collapsed') === 'false'`, 'Shrink off');
      await showRows(true);
      await expandAll();
      await pinLod('components');
      await fit();
      await unlock(false);
      const lockedMarks = {
        controls: await countOf('.arch-resize'),
        titles: await countOf('.react-flow__node.arch-title-drag'),
        hint: await countOf('#resize-hint'),
      };
      await unlock(true);
      await resetByHand();

      // An open group is moved by its title bar alone; the rest of it is canvas.
      const TITLED = 'storefront';
      const atComponents = await drawnNodes();
      const openIds = atComponents.filter((node) => node.kind === 'open').map((node) => node.id);
      const closedId = atComponents.find((node) => node.kind === 'closed')?.id ?? '';
      const leafIds = atComponents
        .filter((node) => node.kind === 'leaf' && node.id.includes('.'))
        .map((node) => node.id);
      /** @type {(PointerRules | null)[]} */
      const openRules = [];
      for (const id of openIds) openRules.push(await rulesOf(id));
      const closedRules = await rulesOf(closedId);
      const leafRules = await rulesOf(leafIds[0] ?? '');
      check(
        'unlocked, an open group takes the pointer at its title bar only, which shows the cursor that moves; a closed group and a leaf take it anywhere',
        openIds.includes(TITLED) &&
          openRules.every(
            (rules) =>
              rules !== null &&
              rules.titleDrag &&
              rules.wrapper === 'none' &&
              rules.header === 'auto' &&
              rules.headerCursor === 'move',
          ) &&
          closedRules !== null &&
          !closedRules.titleDrag &&
          closedRules.wrapper === 'all' &&
          closedRules.boxCursor === 'move' &&
          leafRules !== null &&
          !leafRules.titleDrag &&
          leafRules.wrapper === 'all' &&
          leafRules.boxCursor === 'move',
        { open: openRules.slice(0, 2), closed: closedRules, leaf: leafRules },
      );

      await centreOn(TITLED);
      const DROP = { x: 90, y: 60 };
      /** @type {HandPoint | null} */
      const insideAt = await evaluate(`window.__smoke.panePointIn('${TITLED}')`);
      const viewInside = await viewNow();
      if (insideAt !== null) {
        await drag(insideAt, { x: insideAt.x + DROP.x, y: insideAt.y + DROP.y });
        await settled();
      }
      const viewPanned = await viewNow();
      check(
        'unlocked, a drag from inside an open group pans the map by the drag and moves no box',
        insideAt !== null &&
          Math.abs(viewPanned.x - viewInside.x - DROP.x) <= 3 &&
          Math.abs(viewPanned.y - viewInside.y - DROP.y) <= 3 &&
          Math.abs(viewPanned.zoom - viewInside.zoom) < 0.001 &&
          (await movedCount()) === '0',
        { insideAt, viewInside, viewPanned, moved: await movedCount() },
      );
      /** @type {HandPoint | null} */
      const wheelAt = await evaluate(`window.__smoke.panePointIn('${TITLED}')`);
      if (wheelAt !== null) {
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: wheelAt.x,
          y: wheelAt.y,
          deltaX: 0,
          deltaY: -100,
        });
      }
      const wheelZoomed =
        wheelAt !== null &&
        (await eventually(
          `window.__smoke.viewport().zoom > ${viewPanned.zoom} + 0.001`,
          'the zoom after a wheel turn inside a group',
        ));
      check('unlocked, the wheel inside an open group zooms the map', wheelZoomed, {
        wheelAt,
        before: viewPanned.zoom,
        after: (await viewNow()).zoom,
      });
      await fit();
      await centreOn(TITLED);

      /** @type {HandPoint | null} */
      const clickInside = await evaluate(`window.__smoke.panePointIn('${TITLED}')`);
      if (clickInside !== null) await clickAt(clickInside, `the inside of ${TITLED}`);
      const selectedInside =
        clickInside !== null &&
        (await eventually(
          `window.__smoke.attr('data-selection') === 'node:${TITLED}'`,
          'the group selected by a click inside it',
        ));
      await settled();
      /** @type {HandPoint | null} */
      const outsideAt = await evaluate(`window.__smoke.outsidePoint()`);
      if (outsideAt !== null) await clickAt(outsideAt, 'the empty canvas');
      const clearedOutside =
        outsideAt !== null &&
        (await eventually(
          `window.__smoke.attr('data-selection') === null`,
          'the selection cleared by a click on the empty canvas',
        ));
      check(
        'unlocked, a click inside an open group selects it, and a click on the empty canvas clears the selection',
        selectedInside && clearedOutside && (await movedCount()) === '0',
        { clickInside, selectedInside, outsideAt, clearedOutside },
      );
      await press('Escape', { keyCode: 27 });
      await untilSelection(null);
      await settled();

      const byTitle = await dragFrom(`${nodeOf(TITLED)} .arch-group-header`, DROP);
      const titleMoved = byTitle !== null && (await counted(1, 0));
      await settled();
      const rectsTitle = await rects();
      const titleShift =
        byTitle === null
          ? [NaN, NaN]
          : [
              sideOf(rectsTitle, TITLED, 0) - sideOf(byTitle.before, TITLED, 0),
              sideOf(rectsTitle, TITLED, 1) - sideOf(byTitle.before, TITLED, 1),
            ];
      const insideTitled = byTitle === null ? [] : others(byTitle.before, TITLED, true);
      check(
        'unlocked, a drag from the title bar moves an open group by the drag with everything in it; the view and the other groups stay',
        byTitle !== null &&
          titleMoved &&
          movedByDrag(titleShift[0] ?? NaN, DROP.x) &&
          movedByDrag(titleShift[1] ?? NaN, DROP.y) &&
          insideTitled.length > 0 &&
          insideTitled.every(
            (id) =>
              Math.abs(
                sideOf(rectsTitle, id, 0) - sideOf(byTitle.before, id, 0) - (titleShift[0] ?? NaN),
              ) <= 1 &&
              Math.abs(
                sideOf(rectsTitle, id, 1) - sideOf(byTitle.before, id, 1) - (titleShift[1] ?? NaN),
              ) <= 1,
          ) &&
          shifted(byTitle.before, rectsTitle, others(byTitle.before, TITLED, false)).length === 0 &&
          sameView(byTitle.view, await viewNow()),
        { titleShift, moved: await movedCount(), view: byTitle?.view, now: await viewNow() },
      );
      await resetByHand();

      // The chevron still closes the group, and never drags it. A closed box is picked up anywhere.
      const boxesOpen = await canvasBoxes();
      const collapsedOpen = Number(await attr('data-collapsed-count'));
      await click(`${nodeOf(TITLED)} .arch-chevron`);
      const closedByChevron = await eventually(
        `window.__smoke.attr('data-collapsed-count') === '${collapsedOpen + 1}'`,
        `${TITLED} closed by its chevron`,
      );
      await settled();
      const boxesClosed = await canvasBoxes();
      const rulesClosed = await rulesOf(TITLED);
      const domainIds = Object.keys(boxesOpen).filter((id) => !id.includes('.'));
      check(
        'unlocked, the chevron of an open group closes it and moves nothing; the closed box takes the pointer anywhere again',
        closedByChevron &&
          (await movedCount()) === '0' &&
          domainIds.length > 1 &&
          domainIds.every((id) => sameBox(boxesClosed[id], boxesOpen[id])) &&
          rulesClosed !== null &&
          !rulesClosed.titleDrag &&
          rulesClosed.wrapper === 'all',
        { closedByChevron, moved: await movedCount(), rulesClosed },
      );
      const byMiddle = await dragFrom(nodeOf(TITLED), DROP);
      const middleMoved = byMiddle !== null && (await counted(1, 0));
      await settled();
      const rectsMiddle = await rects();
      const middleShift =
        byMiddle === null
          ? [NaN, NaN]
          : [
              sideOf(rectsMiddle, TITLED, 0) - sideOf(byMiddle.before, TITLED, 0),
              sideOf(rectsMiddle, TITLED, 1) - sideOf(byMiddle.before, TITLED, 1),
            ];
      check(
        'unlocked, a closed group is picked up from its middle and moves by the drag',
        byMiddle !== null &&
          middleMoved &&
          movedByDrag(middleShift[0] ?? NaN, DROP.x) &&
          movedByDrag(middleShift[1] ?? NaN, DROP.y),
        { from: byMiddle?.from, middleShift, moved: await movedCount() },
      );
      await resetByHand();
      await click(`${nodeOf(TITLED)} .arch-chevron`);
      await until(
        `window.__smoke.attr('data-collapsed-count') === '${collapsedOpen}'`,
        `${TITLED} open again`,
      );
      await settled();

      // A leaf: the one nearest to the right border of its group, dragged beyond that border.
      const rectsLeaves = await rects();
      const [nearLeaf] = leafIds
        .map((id) => ({
          id,
          gap: sideOf(rectsLeaves, parentOf(id), 2) - sideOf(rectsLeaves, id, 2),
        }))
        .filter((leaf) => leaf.gap > 2)
        .sort((a, b) => a.gap - b.gap);
      const byLeaf =
        nearLeaf === undefined
          ? null
          : await dragFrom(nodeOf(nearLeaf.id), { x: nearLeaf.gap * 1.2 + 80, y: 0 });
      const leafMoved = byLeaf !== null && (await counted(1, 0));
      await settled();
      const rectsLeaf = await rects();
      const leafBox = rectsLeaf[nearLeaf?.id ?? ''];
      const leafGroup = rectsLeaf[parentOf(nearLeaf?.id ?? '')];
      check(
        'unlocked, a leaf dragged from its middle moves and stays inside its group, which stays as it is',
        nearLeaf !== undefined &&
          byLeaf !== null &&
          leafMoved &&
          leafBox !== undefined &&
          leafGroup !== undefined &&
          (leafBox[0] ?? NaN) > sideOf(byLeaf.before, nearLeaf.id, 0) + 2 &&
          Math.abs((leafBox[2] ?? NaN) - (leafGroup[2] ?? NaN)) <= 1.5 &&
          (leafBox[0] ?? NaN) >= (leafGroup[0] ?? NaN) - 0.5 &&
          (leafBox[1] ?? NaN) >= (leafGroup[1] ?? NaN) - 0.5 &&
          (leafBox[3] ?? NaN) <= (leafGroup[3] ?? NaN) + 0.5 &&
          sameNumbers(leafGroup, byLeaf.before[parentOf(nearLeaf.id)]),
        { nearLeaf, leafBox, leafGroup, moved: await movedCount() },
      );
      await resetByHand();

      // Where no group is drawn open, and while the positions are locked, none is marked.
      await pinLod('domains');
      const titlesAtDomains = await countOf('.react-flow__node.arch-title-drag');
      await pinLod('components');
      await fit();
      const titlesUnlocked = await countOf('.react-flow__node.arch-title-drag');
      check(
        'no group is moved by its title bar alone at the Domains level, where every group is closed, or while the positions are locked',
        titlesAtDomains === 0 && titlesUnlocked === openIds.length && lockedMarks.titles === 0,
        { titlesAtDomains, titlesUnlocked, open: openIds.length, locked: lockedMarks.titles },
      );

      // Resize controls: on open groups only, and only while the positions are unlocked.
      const EIGHT = [
        'handle:bottom-left',
        'handle:bottom-right',
        'handle:top-left',
        'handle:top-right',
        'line:bottom',
        'line:left',
        'line:right',
        'line:top',
      ];
      const complete = (/** @type {DrawnNode} */ node) =>
        same(node.controls, EIGHT) &&
        node.grip !== null &&
        node.grip.tag === 'BUTTON' &&
        node.grip.label === `Resize ${node.name}`;
      const controlsAtComponents = await drawnNodes();
      await pinLod('subcomponents');
      const controlsAtSubcomponents = await drawnNodes();
      await pinLod('components');
      const kindsWithout = controlsAtComponents.filter((node) => node.kind !== 'open');
      check(
        'locked, no group has a resize control; unlocked, every open group has its eight and a grip named after it, and no closed group, leaf or row band has any',
        lockedMarks.controls === 0 &&
          controlsAtComponents.some((node) => node.kind === 'open') &&
          controlsAtComponents.filter((node) => node.kind === 'open').every(complete) &&
          controlsAtSubcomponents.some((node) => node.kind === 'open' && node.id.includes('.')) &&
          controlsAtSubcomponents.filter((node) => node.kind === 'open').every(complete) &&
          ['closed', 'leaf', 'band'].every((kind) =>
            kindsWithout.some((node) => node.kind === kind),
          ) &&
          kindsWithout.every((node) => node.controls.length === 0 && node.grip === null),
        {
          locked: lockedMarks.controls,
          incomplete: [...controlsAtComponents, ...controlsAtSubcomponents]
            .filter((node) => (node.kind === 'open') !== complete(node))
            .slice(0, 4),
        },
      );
      await showControl('#resize-hint');
      check(
        'the Layout tab says how groups are resized only while the positions are unlocked',
        lockedMarks.hint === 0 &&
          (await evaluate(
            `(document.querySelector('#resize-hint')?.getClientRects().length ?? 0) > 0`,
          )) === true,
        { locked: lockedMarks.hint, hint: await text('#resize-hint') },
      );

      // Where the layout left no room, an edge does not come in: the box is back at the drop.
      const FRESH = 'backoffice';
      const storedFresh = await stored();
      const inwards = await dragControl(FRESH, 'handle.top.left', { x: 150, y: 120 });
      await frames();
      const rectsFresh = await rects();
      check(
        'a corner dragged inwards where the layout left no room: after the drop the group and what is in it are where they were, nothing counts as resized or moved, and the view stays',
        inwards !== null &&
          shifted(inwards.before, rectsFresh, Object.keys(inwards.before)).length === 0 &&
          (await resizedCount()) === '0' &&
          (await movedCount()) === '0' &&
          (await stored()) === storedFresh &&
          sameView(inwards.view, await viewNow()),
        {
          pressed: inwards?.from,
          shifted:
            inwards === null
              ? null
              : shifted(inwards.before, rectsFresh, Object.keys(inwards.before)),
          resized: await resizedCount(),
          moved: await movedCount(),
        },
      );

      // The right edge of the domain that ends the map on the right, dragged outwards.
      const boxesAtRest = await canvasBoxes();
      const [EAST = ''] = Object.keys(boxesAtRest)
        .filter((id) => !id.includes('.'))
        .sort(
          (a, b) =>
            (boxesAtRest[b]?.[0] ?? 0) +
            (boxesAtRest[b]?.[2] ?? 0) -
            ((boxesAtRest[a]?.[0] ?? 0) + (boxesAtRest[a]?.[2] ?? 0)),
        );
      const eastAtRest = boxesAtRest[EAST];
      const miniAtRest = await evaluate(`window.__smoke.minimap(${JSON.stringify(EAST)})`);
      const sizeAtRest = String(await attr('data-layout-size'));
      const nameCut = () =>
        /** @type {Promise<number>} */ (
          evaluate(`(() => {
            const name = document.querySelector(${JSON.stringify(`${nodeOf(EAST)} .arch-node-name`)});
            return name.scrollWidth - name.clientWidth;
          })()`)
        );
      const nameCutAtRest = await nameCut();
      const storedAtRest = await stored();
      const WIDER = 120;
      const widen = await dragControl(EAST, 'line.right', { x: WIDER, y: 0 }, { hold: true });
      await frames();
      const rectsHeld = await rects();
      if (widen !== null) await release(widen.to);
      check(
        'while its right edge is dragged, an open group follows the pointer; its other edges, every other box and the view stay',
        widen !== null &&
          sameNumbers(grownBy(widen.before, rectsHeld, EAST), [0, 0, WIDER, 0], 2) &&
          shifted(widen.before, rectsHeld, others(widen.before, EAST, true)).length === 0 &&
          shifted(widen.before, rectsHeld, others(widen.before, EAST, false)).length === 0 &&
          sameView(widen.view, await viewNow()),
        {
          pressed: widen?.from,
          grown: widen === null ? null : grownBy(widen.before, rectsHeld, EAST),
        },
      );
      const widened = widen !== null && (await counted(0, 1));
      await frames();
      const rectsWide = await rects();
      const zoomWide = (await viewNow()).zoom;
      const eastWide = (await canvasBoxes())[EAST];
      check(
        'an open group dragged at its right edge is wider by the drag after the drop; its left edge, what is in it and every other group stay, and nothing counts as moved',
        widen !== null &&
          widened &&
          sameNumbers(grownBy(widen.before, rectsWide, EAST), [0, 0, WIDER, 0], 2) &&
          !!eastAtRest &&
          !!eastWide &&
          Math.abs((eastWide[2] ?? NaN) - (eastAtRest[2] ?? NaN) - WIDER / zoomWide) <= 2 &&
          others(widen.before, EAST, true).length > 0 &&
          shifted(widen.before, rectsWide, others(widen.before, EAST, true)).length === 0 &&
          shifted(widen.before, rectsWide, others(widen.before, EAST, false)).length === 0 &&
          (await selection()) === null,
        {
          grown: widen === null ? null : grownBy(widen.before, rectsWide, EAST),
          eastAtRest,
          eastWide,
          zoomWide,
          moved: await movedCount(),
          resized: await resizedCount(),
        },
      );
      /** @type {Record<string, string>} */
      const keptAtRest = JSON.parse(storedAtRest);
      /** @type {Record<string, string>} */
      const keptWide = JSON.parse(await stored());
      const positionsOf = (/** @type {Record<string, string>} */ kept) =>
        Object.entries(kept).filter(([key]) => key.startsWith('architecture-map.positions:'));
      /** @type {number[] | undefined} */
      const sizeKept = Object.entries(keptWide)
        .filter(([key]) => key.startsWith('architecture-map.sizes:'))
        .map(([, value]) => JSON.parse(value)[EAST])
        .find((entry) => Array.isArray(entry));
      check(
        'the Layout tab counts the resized group, and its size is kept in the browser as how far each edge was moved, beside the positions, which stay as they were',
        (await text('#hand-count')) === '1 resized' &&
          sizeKept !== undefined &&
          sizeKept.length === 4 &&
          sizeKept[0] === 0 &&
          sizeKept[1] === 0 &&
          Math.abs((sizeKept[2] ?? NaN) - WIDER / zoomWide) <= 2 &&
          sizeKept[3] === 0 &&
          same(positionsOf(keptWide), positionsOf(keptAtRest)),
        { count: await text('#hand-count'), sizeKept, positions: positionsOf(keptWide) },
      );
      const miniWide = await evaluate(`window.__smoke.minimap(${JSON.stringify(EAST)})`);
      const sizeWide = String(await attr('data-layout-size'));
      const widthAtRest = Number(sizeAtRest.split('x')[0]);
      const widthWide = Number(sizeWide.split('x')[0]);
      const eastRight = (eastWide?.[0] ?? NaN) + (eastWide?.[2] ?? NaN);
      check(
        'the minimap draws the resized group wider, and the map grows to cover a group resized beyond it',
        miniAtRest.node !== null &&
          miniWide.node !== null &&
          miniWide.node.width > miniAtRest.node.width + 1 &&
          eastRight > widthAtRest &&
          widthWide > widthAtRest &&
          widthWide >= Math.round(eastRight) - 1,
        { miniAtRest: miniAtRest.node, miniWide: miniWide.node, sizeAtRest, sizeWide, eastRight },
      );
      await fit();
      check(
        'Fit view shows the whole of a group resized beyond the map',
        (await evaluate(`window.__smoke.onScreen(${JSON.stringify(nodeOf(EAST))})`)) === true,
        { box: (await rects())[EAST], view: await viewNow() },
      );

      // Far inwards again: the edge stops at what is in the group.
      const storedWide = await stored();
      const zoomNarrow = (await viewNow()).zoom;
      // How far the edge was moved out, in the pixels of the screen at this zoom.
      const wider = ((eastWide?.[2] ?? NaN) - (eastAtRest?.[2] ?? NaN)) * zoomNarrow;
      const narrow = await dragControl(EAST, 'line.right', { x: -(wider + 300), y: 0 });
      const narrowed = narrow !== null && (await storedChanges(storedWide));
      await frames();
      const rectsNarrow = await rects();
      const eastNarrow = (await canvasBoxes())[EAST];
      // How near the right border each box in the group lies, against how near the layout had it
      // (the padding of a group, or less where the layout left less).
      const tooNear =
        narrow === null
          ? []
          : others(narrow.before, EAST, true).filter((id) => {
              const laidOut = sideOf(narrow.before, EAST, 2) - wider - sideOf(narrow.before, id, 2);
              const now = sideOf(rectsNarrow, EAST, 2) - sideOf(rectsNarrow, id, 2);
              return now < Math.min(16 * zoomNarrow, laidOut) - 1;
            });
      check(
        'an edge dragged far inwards stops at what is in the group: no box in it comes nearer to the border than the layout had it, the name is cut no more, and the group is no narrower than the layout made it',
        narrow !== null &&
          narrowed &&
          sideOf(rectsNarrow, EAST, 2) < sideOf(narrow.before, EAST, 2) - 2 &&
          tooNear.length === 0 &&
          shifted(narrow.before, rectsNarrow, others(narrow.before, EAST, true)).length === 0 &&
          (await nameCut()) <= nameCutAtRest &&
          !!eastAtRest &&
          !!eastNarrow &&
          (eastNarrow[2] ?? NaN) >= (eastAtRest[2] ?? NaN) - 0.5,
        { tooNear, eastAtRest, eastNarrow, resized: await resizedCount() },
      );

      // The left edge outwards: that border alone moves.
      const storedNarrow = await stored();
      const LEFT_OUT = 80;
      const leftOut = await dragControl(EAST, 'line.left', { x: -LEFT_OUT, y: 0 }, { hold: true });
      await frames();
      const rectsLeftHeld = await rects();
      if (leftOut !== null) await release(leftOut.to);
      check(
        'while its left edge is dragged, what is in a group stays where it is on screen',
        leftOut !== null &&
          sameNumbers(grownBy(leftOut.before, rectsLeftHeld, EAST), [LEFT_OUT, 0, 0, 0], 2) &&
          shifted(leftOut.before, rectsLeftHeld, others(leftOut.before, EAST, true)).length === 0,
        {
          pressed: leftOut?.from,
          grown: leftOut === null ? null : grownBy(leftOut.before, rectsLeftHeld, EAST),
          shifted:
            leftOut === null
              ? null
              : shifted(leftOut.before, rectsLeftHeld, others(leftOut.before, EAST, true)),
        },
      );
      const leftGrown = leftOut !== null && (await storedChanges(storedNarrow));
      await frames();
      const rectsLeft = await rects();
      check(
        'a left edge dragged outwards moves that border alone: the right edge, what is in the group and every other group stay, and nothing counts as moved',
        leftOut !== null &&
          leftGrown &&
          sameNumbers(grownBy(leftOut.before, rectsLeft, EAST), [LEFT_OUT, 0, 0, 0], 2) &&
          shifted(leftOut.before, rectsLeft, others(leftOut.before, EAST, true)).length === 0 &&
          shifted(leftOut.before, rectsLeft, others(leftOut.before, EAST, false)).length === 0 &&
          (await movedCount()) === '0' &&
          (await resizedCount()) === '1',
        {
          grown: leftOut === null ? null : grownBy(leftOut.before, rectsLeft, EAST),
          moved: await movedCount(),
          resized: await resizedCount(),
        },
      );
      await fit();

      // A double-click on an edge gives the group the size of the layout back.
      const collapsedResized = await attr('data-collapsed-count');
      /** @type {HandPoint | null} */
      const edgeAt = await evaluate(
        `window.__smoke.pressPoint(${JSON.stringify(`${nodeOf(EAST)} .arch-resize.line.right`)})`,
      );
      if (edgeAt !== null) await doubleClickAt(edgeAt);
      const sizeGivenBack = edgeAt !== null && (await counted(0, 0));
      await frames();
      const eastBack = (await canvasBoxes())[EAST];
      check(
        'a double-click on an edge of a resized group gives it the size of the layout back; the group is neither closed nor selected by it',
        sizeGivenBack &&
          sameBox(eastBack, eastAtRest) &&
          (await attr('data-collapsed-count')) === collapsedResized &&
          (await evaluate(
            `document.querySelector(${JSON.stringify(`${nodeOf(EAST)} .arch-node`)})?.dataset.collapsed`,
          )) === 'false' &&
          (await selection()) === null,
        {
          edgeAt,
          eastBack,
          eastAtRest,
          resized: await resizedCount(),
          selected: await selection(),
        },
      );

      // The grip takes the keyboard: the arrow keys move the right and the bottom edge, with
      // Shift the left and the top edge, and Delete gives the size back.
      const gripOf = (/** @type {string} */ id) => `${nodeOf(id)} .arch-resize-grip`;
      const gripFocused = (/** @type {string} */ id) =>
        `document.activeElement !== null && document.activeElement === document.querySelector(${JSON.stringify(gripOf(id))})`;
      /** Gives the grip of the group the focus with a click on it: whether the click did. */
      const focusGrip = async (/** @type {string} */ id) => {
        /** @type {HandPoint | null} */
        const point = await evaluate(`window.__smoke.pressPoint(${JSON.stringify(gripOf(id))})`);
        if (point !== null) await clickAt(point, `the grip of ${id}`);
        const byClick =
          point !== null && (await eventually(gripFocused(id), 'the focus on the grip'));
        // The keys are what is checked below: without the click, the grip is focused directly.
        if (!byClick) {
          await evaluate(`document.querySelector(${JSON.stringify(gripOf(id))})?.focus()`);
        }
        return byClick;
      };
      const widthIs = (/** @type {string} */ id, /** @type {number} */ width) =>
        `(window.__smoke.canvasBoxes()[${JSON.stringify(id)}] ?? [])[2] === ${width}`;
      const STEP = 8;
      const restWidth = eastAtRest?.[2] ?? NaN;
      const viewKeys = await viewNow();
      const gripByClick = await focusGrip(EAST);
      const selectedByGrip = await selection();
      await press('ArrowRight', { keyCode: 39 });
      const keyWider =
        (await counted(0, 1)) &&
        (await eventually(widthIs(EAST, restWidth + STEP), 'the group wider by a key'));
      const eastKeyRight = (await canvasBoxes())[EAST];
      const focusAfterRight = await evaluate(gripFocused(EAST));
      await press('ArrowLeft', { keyCode: 37, modifiers: 8 });
      const keyLeft = await eventually(
        widthIs(EAST, restWidth + 2 * STEP),
        'the left edge moved out by a key',
      );
      const eastKeyLeft = (await canvasBoxes())[EAST];
      const focusAfterLeft = await evaluate(gripFocused(EAST));
      await press('Delete', { keyCode: 46 });
      const keyBack = await counted(0, 0);
      await frames();
      const eastKeyBack = (await canvasBoxes())[EAST];
      check(
        'the arrow keys on the grip of a group move its right edge by 8, with Shift its left edge, and Delete gives the size of the layout back; the grip keeps the focus, nothing is selected and neither the page nor the map moves',
        keyWider &&
          !!eastAtRest &&
          sameBox(eastKeyRight, [
            eastAtRest[0] ?? NaN,
            eastAtRest[1] ?? NaN,
            restWidth + STEP,
            eastAtRest[3] ?? NaN,
          ]) &&
          focusAfterRight === true &&
          keyLeft &&
          sameBox(eastKeyLeft, [
            (eastAtRest[0] ?? NaN) - STEP,
            eastAtRest[1] ?? NaN,
            restWidth + 2 * STEP,
            eastAtRest[3] ?? NaN,
          ]) &&
          focusAfterLeft === true &&
          keyBack &&
          sameBox(eastKeyBack, eastAtRest) &&
          (await evaluate(gripFocused(EAST))) === true &&
          selectedByGrip === null &&
          (await evaluate(`window.scrollX === 0 && window.scrollY === 0`)) === true &&
          sameView(viewKeys, await viewNow()),
        {
          gripByClick,
          eastAtRest,
          eastKeyRight,
          eastKeyLeft,
          eastKeyBack,
          focus: [focusAfterRight, focusAfterLeft],
          selectedByGrip,
        },
      );
      await park();

      // Room gained belongs to the group: a box in it can be moved beyond the old border. Then
      // one button puts back the box moved and the group resized.
      const boxesBeforeBoth = await canvasBoxes();
      const again = await dragControl(EAST, 'line.right', { x: WIDER, y: 0 });
      const grownAgain = again !== null && (await counted(0, 1));
      await frames();
      const rectsGrown = await rects();
      const oldBorder = sideOf(rectsGrown, EAST, 2) - WIDER;
      const [nearest] = others(rectsGrown, EAST, true)
        .filter((id) => parentOf(id) === EAST)
        .map((id) => ({ id, gap: oldBorder - sideOf(rectsGrown, id, 2) }))
        .sort((a, b) => a.gap - b.gap);
      const intoRoom =
        nearest === undefined || !grownAgain
          ? null
          : await dragFrom(nodeOf(nearest.id), { x: nearest.gap * 1.2 + 70, y: 0 });
      const movedIntoRoom = intoRoom !== null && (await counted(1, 1));
      await settled();
      await frames();
      const rectsRoom = await rects();
      check(
        'a box inside a group that was grown can be moved into the room gained, beyond the border the layout gave the group, and stays there',
        nearest !== undefined &&
          intoRoom !== null &&
          movedIntoRoom &&
          sideOf(rectsRoom, nearest.id, 2) > sideOf(rectsRoom, EAST, 2) - WIDER + 10 &&
          sideOf(rectsRoom, nearest.id, 2) <= sideOf(rectsRoom, EAST, 2) + 0.5,
        {
          nearest,
          box: rectsRoom[nearest?.id ?? ''],
          group: rectsRoom[EAST],
          moved: await movedCount(),
        },
      );
      const resetDisabled = await evaluate(`document.querySelector('#reset-positions').disabled`);
      await click('#reset-positions');
      const bothBack = await counted(0, 0);
      await settled();
      const boxesAfterReset = await canvasBoxes();
      check(
        'Reset positions puts a moved box and a resized group back as the layout made them, and can then not be chosen',
        resetDisabled === false &&
          movedIntoRoom &&
          bothBack &&
          Object.keys(boxesBeforeBoth).length > 0 &&
          Object.keys(boxesBeforeBoth).every((id) =>
            sameBox(boxesAfterReset[id], boxesBeforeBoth[id]),
          ) &&
          (await evaluate(`document.querySelector('#reset-positions').disabled`)) === true &&
          (await countOf('#hand-count')) === 0,
        { resetDisabled, moved: await movedCount(), resized: await resizedCount() },
      );

      // An edge of the map that ends on the side of a group follows that side.
      /** The sides of a box: which coordinate of a point lies across it, and which way is out. */
      const SIDES = [
        { name: 'right', index: 2, axis: 0, out: 1 },
        { name: 'bottom', index: 3, axis: 1, out: 1 },
        { name: 'left', index: 0, axis: 0, out: -1 },
        { name: 'top', index: 1, axis: 1, out: -1 },
      ];
      const edgeEndsAt = (/** @type {string} */ id) =>
        /** @type {Promise<EdgeEnds[]>} */ (
          evaluate(`window.__smoke.edgeEndsAt(${JSON.stringify(id)})`)
        );
      const rectsEdges = await rects();
      /** @type {{ id: string, side: typeof SIDES[number], edge: string, end: number, offset: number, d: string } | undefined} */
      let ending;
      for (const id of openIds) {
        const box = rectsEdges[id];
        if (ending !== undefined || box === undefined) continue;
        const drawnEdges = await edgeEndsAt(id);
        for (const side of SIDES) {
          for (const edge of drawnEdges) {
            for (const [end, point] of edge.ends.entries()) {
              const offset = (point[side.axis] ?? NaN) - (box[side.index] ?? NaN);
              const along = point[1 - side.axis] ?? NaN;
              const within =
                along >= (box[1 - side.axis] ?? NaN) - 8 &&
                along <= (box[3 - side.axis] ?? NaN) + 8;
              if (ending === undefined && Math.abs(offset) <= 8 && within) {
                ending = { id, side, edge: edge.id, end, offset, d: edge.d };
              }
            }
          }
        }
      }
      const OUT = 60;
      const pushed =
        ending === undefined
          ? null
          : await dragControl(
              ending.id,
              `line.${ending.side.name}`,
              ending.side.axis === 0
                ? { x: OUT * ending.side.out, y: 0 }
                : { x: 0, y: OUT * ending.side.out },
            );
      const pushedOut = pushed !== null && (await counted(0, 1));
      const rerouted =
        ending !== undefined &&
        pushedOut &&
        (await eventually(
          `window.__smoke.attr('data-lines-laid-out') === 'true' && window.__smoke.edgeEndsAt(${JSON.stringify(ending.id)}).some((edge) => edge.id === ${JSON.stringify(ending.edge)} && edge.d !== ${JSON.stringify(ending.d)})`,
          'the edge drawn anew',
        ));
      const rectsPushed = await rects();
      const endNow =
        ending === undefined
          ? undefined
          : (await edgeEndsAt(ending.id)).find((edge) => edge.id === ending.edge)?.ends[ending.end];
      // The edge is routed anew and may leave the box at another side: how far its end lies from
      // the border of the box as it is now, whichever side that is. (An edge left as it was would
      // end inside the box, where the border was.)
      const boxPushed = ending === undefined ? undefined : rectsPushed[ending.id];
      const [endX = NaN, endY = NaN] = endNow ?? [];
      const [boxLeft = NaN, boxTop = NaN, boxRight = NaN, boxBottom = NaN] = boxPushed ?? [];
      const outside = Math.hypot(
        Math.max(boxLeft - endX, 0, endX - boxRight),
        Math.max(boxTop - endY, 0, endY - boxBottom),
      );
      const offBorder =
        outside > 0
          ? outside
          : Math.min(endX - boxLeft, boxRight - endX, endY - boxTop, boxBottom - endY);
      check(
        'an edge that ends on the side of a group that is resized ends on the new border after the drop',
        ending !== undefined &&
          pushed !== null &&
          rerouted &&
          Math.abs(grownBy(pushed.before, rectsPushed, ending.id)[ending.side.index] ?? NaN) >=
            OUT - 2 &&
          offBorder <= Math.abs(ending.offset) + 1.5,
        { ending, pushedOut, rerouted, endNow, boxPushed, offBorder },
      );
      await resetByHand();
      await fit();

      // The grip in both colour schemes: fainter than the text where the size is the layout's,
      // the accent colour where it was set by hand. A hovered edge shows a line.
      /** The grip colours of a resized and of an untouched group in the scheme that is on. */
      const gripColours = async () => ({
        resized: await evaluate(`window.__smoke.gripColour(${JSON.stringify(EAST)})`),
        plain: await evaluate(`window.__smoke.gripColour(${JSON.stringify(FRESH)})`),
      });
      const schemeIs = async (/** @type {'light' | 'dark'} */ scheme) => {
        await client.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: scheme }],
        });
        await until(
          `window.matchMedia('(prefers-color-scheme: ${scheme})').matches`,
          `the ${scheme} colour scheme`,
        );
        await frames();
      };
      const gripByClickAgain = await focusGrip(EAST);
      await press('ArrowRight', { keyCode: 39 });
      const resizedForColour = await counted(0, 1);
      await park();
      await schemeIs('dark');
      const gripsDark = await gripColours();
      await schemeIs('light');
      const gripsLight = await gripColours();
      const lineOf = `${nodeOf(EAST)} .arch-resize.line.right`;
      const lineParked = await evaluate(`window.__smoke.controlLine(${JSON.stringify(lineOf)})`);
      /** @type {HandPoint | null} */
      const lineAt = await evaluate(`window.__smoke.pressPoint(${JSON.stringify(lineOf)})`);
      if (lineAt !== null) {
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...lineAt });
      }
      // The line may fade in: waited for, not read after a fixed time.
      const lineShown =
        lineAt !== null &&
        gripsLight.resized !== null &&
        (await eventually(
          `(() => {
            const line = window.__smoke.controlLine(${JSON.stringify(lineOf)});
            return line !== null && line.hovered && line.look.includes(${JSON.stringify(gripsLight.resized.accent)});
          })()`,
          'the line of the hovered edge control',
        ));
      const lineHovered = await evaluate(`window.__smoke.controlLine(${JSON.stringify(lineOf)})`);
      await park();
      await client.send('Emulation.setEmulatedMedia', {});
      check(
        'the grip of a group is drawn in both colour schemes, in the accent colour once the size is set by hand, and a hovered edge control shows a line in that colour',
        resizedForColour &&
          [gripsDark, gripsLight].every(
            (grips) =>
              grips.resized !== null &&
              grips.plain !== null &&
              grips.resized.resized === 'true' &&
              grips.plain.resized !== 'true' &&
              grips.resized.colour === grips.resized.accent &&
              grips.plain.colour !== grips.plain.accent,
          ) &&
          gripsDark.plain.colour !== gripsLight.plain.colour &&
          lineShown &&
          lineParked !== null &&
          lineHovered !== null &&
          lineParked.hovered === false &&
          lineHovered.look !== lineParked.look,
        { gripByClickAgain, gripsDark, gripsLight, lineParked, lineHovered },
      );

      // A size set by hand is kept: a reload draws it again, locked as the map starts.
      const eastKept = (await canvasBoxes())[EAST];
      await open();
      const reloaded = {
        resized: await resizedCount(),
        unlocked: await attr('data-positions-unlocked'),
        controls: await countOf('.arch-resize'),
      };
      await pinLod('components');
      await fit();
      const eastReloaded = (await canvasBoxes())[EAST];
      check(
        'a size set by hand is still there after a reload, and while the positions are locked the group keeps it and has no resize control',
        resizedForColour &&
          reloaded.resized === '1' &&
          reloaded.unlocked === 'false' &&
          reloaded.controls === 0 &&
          !!eastAtRest &&
          !!eastKept &&
          (eastKept[2] ?? NaN) === (eastAtRest[2] ?? NaN) + STEP &&
          sameBox(eastReloaded, eastKept),
        { reloaded, eastAtRest, eastKept, eastReloaded },
      );
      await unlock(true);
      await until(
        `window.__smoke.count(${JSON.stringify(`${nodeOf(EAST)} .arch-resize`)}) === 8`,
        'the resize controls after unlocking again',
      );

      // Closed, the group keeps the box set by hand; drawn shrunk, the small box lies in its middle.
      await centreOn(EAST);
      const collapsedKept = Number(await attr('data-collapsed-count'));
      await click(`${nodeOf(EAST)} .arch-chevron`);
      await until(
        `window.__smoke.attr('data-collapsed-count') === '${collapsedKept + 1}'`,
        `${EAST} closed`,
      );
      await settled();
      const eastClosed = (await canvasBoxes())[EAST];
      const closedControls = await countOf(`${nodeOf(EAST)} .arch-resize`);
      await setSetting('compact-collapsed', true);
      const drawnShrunk = await eventually(
        `window.__smoke.count(${JSON.stringify(`${nodeOf(EAST)} .arch-group.arch-compact`)}) === 1`,
        'the closed group drawn shrunk',
      );
      const eastShrunk = (await canvasBoxes())[EAST];
      await setSetting('compact-collapsed', false);
      await until(
        `window.__smoke.attr('data-compact-collapsed') === 'false' && window.__smoke.count('.arch-group.arch-compact') === 0`,
        'full boxes again',
      );
      await click(`${nodeOf(EAST)} .arch-chevron`);
      await until(
        `window.__smoke.attr('data-collapsed-count') === '${collapsedKept}'`,
        `${EAST} open again`,
      );
      await settled();
      const eastReopened = (await canvasBoxes())[EAST];
      /** The middle of a box of the canvas (left, top, width, height). */
      const middleOf = (/** @type {number[] | null | undefined} */ box) =>
        box
          ? [(box[0] ?? NaN) + (box[2] ?? NaN) / 2, (box[1] ?? NaN) + (box[3] ?? NaN) / 2]
          : undefined;
      check(
        'a resized group that is closed keeps the size set by hand and has no resize control; drawn shrunk, the small box lies in the middle of it; opened again it is as before',
        sameBox(eastClosed, eastKept) &&
          closedControls === 0 &&
          drawnShrunk &&
          !!eastShrunk &&
          !!eastKept &&
          // The small box is no wider and no taller than the group, and smaller one way at least
          // (a narrow group keeps its width).
          (eastShrunk[2] ?? NaN) <= (eastKept[2] ?? NaN) &&
          (eastShrunk[3] ?? NaN) <= (eastKept[3] ?? NaN) &&
          (eastShrunk[2] ?? NaN) * (eastShrunk[3] ?? NaN) <
            (eastKept[2] ?? NaN) * (eastKept[3] ?? NaN) - 1 &&
          sameNumbers(middleOf(eastShrunk), middleOf(eastKept)) &&
          sameBox(eastReopened, eastKept) &&
          (await countOf(`${nodeOf(EAST)} .arch-resize`)) === 8 &&
          (await resizedCount()) === '1',
        { eastKept, eastClosed, closedControls, eastShrunk, eastReopened },
      );
      await resetByHand();

      // Zoomed out to half the size, the controls are enlarged against the zoom.
      await fit();
      const wheelOver = await evaluate(`window.__smoke.canvasMiddle()`);
      if (!wheelOver.onCanvas) throw new Error('something lies over the middle of the canvas');
      for (let turn = 0; turn < 8; turn++) {
        const { zoom } = await viewNow();
        if (Math.abs(zoom - 0.5) < 0.002) break;
        // A wheel turn of 500 halves the zoom.
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: wheelOver.x,
          y: wheelOver.y,
          deltaX: 0,
          deltaY: Math.max(-400, Math.min(400, 500 * Math.log2(zoom / 0.5))),
        });
        await until(
          `Math.abs(window.__smoke.viewport().zoom - ${zoom}) > 1e-6`,
          'the zoom after a wheel turn',
        );
        await settled();
      }
      await park();
      const half = {
        zoom: (await viewNow()).zoom,
        unzoom: await evaluate(`window.__smoke.unzoom()`),
        thick: await evaluate(
          `document.querySelector(${JSON.stringify(`${nodeOf(FRESH)} .arch-resize.line.right`)})?.getBoundingClientRect().width ?? null`,
        ),
      };
      await unlock(false);
      const unzoomLocked = await evaluate(`window.__smoke.unzoom()`);
      await unlock(true);
      check(
        'at half the size the edge controls of a group are still 7 pixels thick on screen, enlarged by the factor the canvas states, which is gone once the positions are locked',
        Math.abs(half.zoom - 0.5) < 0.005 &&
          Math.abs(Number(half.unzoom) - 2) < 0.03 &&
          typeof half.thick === 'number' &&
          half.thick >= 7 &&
          half.thick <= 9 &&
          unzoomLocked === '',
        { half, unzoomLocked },
      );
      await fit();

      // One group, three places to press: the title bar, the top edge, the inside.
      const NUDGE = { x: 60, y: 40 };
      const byHeader = await dragFrom(`${nodeOf(FRESH)} .arch-group-header`, NUDGE);
      const headerMoved = byHeader !== null && (await counted(1, 0));
      await settled();
      const byTop = await dragControl(FRESH, 'line.top', { x: 0, y: -NUDGE.y });
      const topGrown = byTop !== null && (await counted(1, 1));
      await frames();
      const rectsTop = await rects();
      const viewAfterTop = await viewNow();
      /** @type {HandPoint | null} */
      const bodyAt = await evaluate(`window.__smoke.panePointIn('${FRESH}')`);
      if (bodyAt !== null) {
        await drag(bodyAt, { x: bodyAt.x + NUDGE.x, y: bodyAt.y + NUDGE.y });
        await settled();
      }
      const viewBody = await viewNow();
      check(
        'unlocked, a group is moved at its title bar, resized at its top edge, and the map is panned inside it',
        headerMoved &&
          byTop !== null &&
          topGrown &&
          sameNumbers(grownBy(byTop.before, rectsTop, FRESH), [0, NUDGE.y, 0, 0], 2) &&
          sameView(byTop.view, viewAfterTop) &&
          bodyAt !== null &&
          Math.abs(viewBody.x - viewAfterTop.x - NUDGE.x) <= 3 &&
          Math.abs(viewBody.y - viewAfterTop.y - NUDGE.y) <= 3 &&
          (await movedCount()) === '1' &&
          (await resizedCount()) === '1',
        {
          headerMoved,
          grown: byTop === null ? null : grownBy(byTop.before, rectsTop, FRESH),
          viewAfterTop,
          viewBody,
          moved: await movedCount(),
          resized: await resizedCount(),
        },
      );
      await resetByHand();

      // A group inside another: it grows as far as the border of the group around it, and
      // upwards as far as that group's title bar. The one nearest to a border is taken.
      await pinLod('subcomponents');
      await fit();
      const rectsNested = await rects();
      const [inner] = (await drawnNodes())
        .filter((node) => node.kind === 'open' && node.id.includes('.'))
        .flatMap((node) =>
          SIDES.filter((side) => side.name !== 'top').map((side) => ({
            id: node.id,
            side,
            gap:
              (sideOf(rectsNested, parentOf(node.id), side.index) -
                sideOf(rectsNested, node.id, side.index)) *
              side.out,
          })),
        )
        .filter((candidate) => candidate.gap > 2)
        .sort((a, b) => a.gap - b.gap);
      if (inner === undefined) throw new Error('no open group inside another to resize');
      const OUTER = parentOf(inner.id);
      const FAR = 80;
      const beyond = await dragControl(
        inner.id,
        `line.${inner.side.name}`,
        inner.side.axis === 0
          ? { x: (inner.gap + FAR) * inner.side.out, y: 0 }
          : { x: 0, y: (inner.gap + FAR) * inner.side.out },
      );
      const grownInside = beyond !== null && (await counted(0, 1));
      await frames();
      const rectsBeyond = await rects();
      const storedBeyond = await stored();
      const headerBottom = () =>
        /** @type {Promise<number>} */ (
          evaluate(
            `document.querySelector(${JSON.stringify(`${nodeOf(OUTER)} .arch-group-header`)}).getBoundingClientRect().bottom`,
          )
        );
      const upwards = await dragControl(inner.id, 'line.top', {
        x: 0,
        y: -(sideOf(rectsBeyond, inner.id, 1) - sideOf(rectsBeyond, OUTER, 1) + FAR),
      });
      const grownUp = upwards !== null && (await storedChanges(storedBeyond));
      await frames();
      const rectsUp = await rects();
      const titleBottom = await headerBottom();
      check(
        'a group inside another cannot be grown beyond it: its edge ends on the border of the group around it, upwards below the title bar of that group, and the group around it keeps its size',
        beyond !== null &&
          grownInside &&
          Math.abs(
            sideOf(rectsBeyond, inner.id, inner.side.index) -
              sideOf(rectsBeyond, OUTER, inner.side.index),
          ) <= 1.5 &&
          sameNumbers(rectsBeyond[OUTER], beyond.before[OUTER]) &&
          shifted(beyond.before, rectsBeyond, others(beyond.before, inner.id, true)).length === 0 &&
          upwards !== null &&
          grownUp &&
          sideOf(rectsUp, inner.id, 1) < sideOf(upwards.before, inner.id, 1) - 1 &&
          Math.abs(sideOf(rectsUp, inner.id, 1) - titleBottom) <= 2 &&
          sameNumbers(rectsUp[OUTER], upwards.before[OUTER]),
        {
          inner: { id: inner.id, side: inner.side.name, gap: inner.gap },
          box: rectsBeyond[inner.id],
          around: rectsBeyond[OUTER],
          top: sideOf(rectsUp, inner.id, 1),
          titleBottom,
        },
      );
      await resetByHand();

      // Closed up, a size belongs to one arrangement, as a moved position does: another set of
      // closed groups, the map without rows and a filtered map each have their own.
      const OTHER = 'platform';
      await closeUp(true);
      await pinLod('components');
      await fit();
      const arrangementSet = await attr('data-arrangement');
      /** Width and height of a box of the canvas. */
      const sizeOf = async (/** @type {string} */ id) => ((await canvasBoxes())[id] ?? []).slice(2);
      /** Closes or opens another group by its chevron and waits for the arrangement that follows. */
      const otherClosed = async (/** @type {boolean} */ closed) => {
        await centreOn(OTHER);
        await click(`${nodeOf(OTHER)} .arch-chevron`);
        await until(
          `window.__smoke.attr('data-arrangement') ${closed ? '!==' : '==='} ${JSON.stringify(arrangementSet)} && window.__smoke.attr('data-lines-laid-out') === 'true'`,
          closed ? 'the arrangement with another group closed' : 'the first arrangement again',
        );
        await settled();
      };
      await otherClosed(true);
      const computedElsewhere = await sizeOf(FRESH);
      await otherClosed(false);
      const computedHere = await sizeOf(FRESH);
      const setHere = await dragControl(FRESH, 'line.right', { x: 80, y: 0 });
      const resizedHere = setHere !== null && (await counted(0, 1));
      await frames();
      const sizeHere = await sizeOf(FRESH);
      await otherClosed(true);
      const elsewhere = { size: await sizeOf(FRESH), resized: await resizedCount() };
      await otherClosed(false);
      const hereAgain = { size: await sizeOf(FRESH), resized: await resizedCount() };
      check(
        'closed up, a size set by hand belongs to the arrangement it was set in: with another group closed the group has the computed size, back in the first arrangement the size set',
        arrangementSet !== 'full' &&
          resizedHere &&
          (sizeHere[0] ?? NaN) > (computedHere[0] ?? NaN) + 20 &&
          sameNumbers(elsewhere.size, computedElsewhere, 0.5) &&
          elsewhere.resized === '0' &&
          sameNumbers(hereAgain.size, sizeHere, 0.5) &&
          hereAgain.resized === '1',
        { arrangementSet, computedHere, sizeHere, computedElsewhere, elsewhere, hereAgain },
      );
      await showRows(false);
      const withoutRows = await resizedCount();
      await showRows(true);
      const withRows = { size: await sizeOf(FRESH), resized: await resizedCount() };
      await filterMode();
      const EPIC = 'workitem:1001';
      await chooseOption('#focus-select', EPIC);
      await untilFiltered(EPIC);
      const onFiltered = await resizedCount();
      await press('Escape', { keyCode: 27 });
      await untilSelection(null);
      await click('#focus-clear');
      await until(`window.__smoke.attr('data-focus') === null`, 'the focus cleared');
      await untilFiltered(null);
      const onWhole = { size: await sizeOf(FRESH), resized: await resizedCount() };
      check(
        'a size set by hand is not on the map without rows nor on a filtered map, and is back with the rows and on the whole map',
        resizedHere &&
          withoutRows === '0' &&
          withRows.resized === '1' &&
          sameNumbers(withRows.size, sizeHere, 0.5) &&
          onFiltered === '0' &&
          onWhole.resized === '1' &&
          sameNumbers(onWhole.size, sizeHere, 0.5),
        { sizeHere, withoutRows, withRows, onFiltered, onWhole },
      );
      await showControl('#reset-positions');
      await resetByHand();
      await closeUp(false);
      await unlock(false);

      // --- Heat and progress of what is drawn: an open group counts what no box in it shows ---
      await expandAll();
      await setSetting('heat', true);
      await setSetting('progress', true);
      await until(
        `window.__smoke.count('.arch-heat-left') > 0 && window.__smoke.count('.arch-progress') > 0`,
        'the heat strips and the progress bars',
      );
      const lensFigures = () =>
        /** @type {Promise<{ strips: HeatStrip[], bars: ProgressBar[] }>} */ (
          evaluate(`window.__smoke.lensFigures()`)
        );
      const sum = (/** @type {number[]} */ values) =>
        values.reduce((total, value) => total + value, 0);
      /** @type {{ level: string, open: number, items: number }[]} */
      const perLevel = [];
      for (const level of ['domains', 'components', 'subcomponents']) {
        await pinLod(level);
        const figures = await lensFigures();
        perLevel.push({
          level,
          open: sum(figures.strips.map((strip) => strip.heat)),
          items: sum(figures.bars.map((bar) => bar.total)),
        });
      }
      check(
        'heat strips and progress bars count every item on one box: their sums are the same at the Domains, the Components and the Subcomponents level',
        perLevel.length === 3 &&
          perLevel.every(
            (figures) =>
              figures.open > 0 &&
              figures.items > 0 &&
              figures.open === perLevel[0]?.open &&
              figures.items === perLevel[0]?.items,
          ),
        perLevel,
      );

      // Still at the Subcomponents level: every group is open.
      await fit();
      const figuresOpen = await lensFigures();
      const marksOf = (
        /** @type {{ strips: HeatStrip[], bars: ProgressBar[] }} */ figures,
        /** @type {string} */ id,
      ) =>
        figures.strips.filter((strip) => strip.id === id).length +
        figures.bars.filter((bar) => bar.id === id).length;
      check(
        'an open group with nothing of its own has no heat strip and no progress bar, while a group in it with work of its own has both',
        marksOf(figuresOpen, 'backoffice') === 0 &&
          (await countOf(
            `${nodeOf('backoffice')} .arch-heat, ${nodeOf('backoffice')} .arch-progress`,
          )) === 0 &&
          marksOf(figuresOpen, 'backoffice.config-manager') === 2,
        {
          backoffice: marksOf(figuresOpen, 'backoffice'),
          inside: marksOf(figuresOpen, 'backoffice.config-manager'),
        },
      );
      const CLOSED = 'storefront.web';
      const heatOf = (/** @type {{ strips: HeatStrip[] }} */ figures, /** @type {string} */ id) =>
        figures.strips.find((strip) => strip.id === id)?.heat ?? 0;
      const collapsedLenses = Number(await attr('data-collapsed-count'));
      await centreOn(CLOSED);
      await click(`${nodeOf(CLOSED)} .arch-chevron`);
      await until(
        `window.__smoke.attr('data-collapsed-count') === '${collapsedLenses + 1}'`,
        `${CLOSED} closed`,
      );
      await settled();
      const figuresClosed = await lensFigures();
      const insideClosed = figuresOpen.strips.filter((strip) => strip.id.startsWith(`${CLOSED}.`));
      const outsideClosed = figuresOpen.strips.filter(
        (strip) => strip.id !== CLOSED && !strip.id.startsWith(`${CLOSED}.`),
      );
      const changedStrips = outsideClosed.filter((strip) => {
        const now = figuresClosed.strips.find((other) => other.id === strip.id);
        return !now || now.heat !== strip.heat || Math.abs(now.height - strip.height) > 0.5;
      });
      check(
        'closing a group adds the open work of the boxes inside it to its heat strip; every other strip keeps its figure and its height',
        insideClosed.length > 0 &&
          heatOf(figuresOpen, CLOSED) > 0 &&
          heatOf(figuresClosed, CLOSED) ===
            heatOf(figuresOpen, CLOSED) + sum(insideClosed.map((strip) => strip.heat)) &&
          outsideClosed.length > 0 &&
          changedStrips.length === 0,
        {
          open: heatOf(figuresOpen, CLOSED),
          inside: insideClosed.map((strip) => [strip.id, strip.heat]),
          closed: heatOf(figuresClosed, CLOSED),
          changedStrips,
        },
      );
      await click(`${nodeOf(CLOSED)} .arch-chevron`);
      await until(
        `window.__smoke.attr('data-collapsed-count') === '${collapsedLenses}'`,
        `${CLOSED} open again`,
      );
      await settled();

      await pinLod('components');
      await fit();
      const figuresComponents = await lensFigures();
      const partStrip = figuresComponents.strips.find((strip) => strip.id === 'storefront');
      const partBar = figuresComponents.bars.find((bar) => bar.id === 'storefront');
      check(
        'an open group with work of its own shows that figure, less than the work in it in all, and its tooltip states both',
        partStrip !== undefined &&
          partStrip.all !== null &&
          partStrip.heat > 0 &&
          partStrip.heat < partStrip.all &&
          partStrip.title.includes('in all') &&
          partBar !== undefined &&
          partBar.totalAll !== null &&
          partBar.doneAll !== null &&
          partBar.total < partBar.totalAll &&
          partBar.title.includes('in all'),
        { partStrip, partBar },
      );
      await click(`${nodeOf('storefront')} .arch-group-header`);
      await untilSelection('node:storefront');
      const panelGroup = {
        work: await text('#detail-work'),
        drawn: await text('#detail-work-drawn'),
      };
      await press('Escape', { keyCode: 27 });
      await untilSelection(null);
      await fit();
      await click(nodeOf('data.event-store'));
      await untilSelection('node:data.event-store');
      const panelLeaf = {
        work: await countOf('#detail-work'),
        drawn: await countOf('#detail-work-drawn'),
      };
      await press('Escape', { keyCode: 27 });
      await untilSelection(null);
      check(
        'the node panel states the work of a group with everything inside it and, on a line of its own, what its box on the map shows; a leaf has no such line',
        partStrip !== undefined &&
          String(panelGroup.work).startsWith(`${partStrip.all} open item`) &&
          String(panelGroup.drawn).startsWith('On the map:') &&
          panelLeaf.work === 1 &&
          panelLeaf.drawn === 0,
        { panelGroup, panelLeaf },
      );

      // Filter leaves boxes out: what they hold is counted on the drawn group around them.
      await pinLod('subcomponents');
      await filterMode();
      await chooseOption('#focus-select', EPIC);
      await untilFiltered(EPIC);
      await until(
        `window.__smoke.attr('data-lod') === 'subcomponents'`,
        'the level kept by Filter',
      );
      const figuresFiltered = await lensFigures();
      const filteredStrip = figuresFiltered.strips.find((strip) => strip.id === 'backoffice');
      await press('Escape', { keyCode: 27 });
      await untilSelection(null);
      await click('#focus-clear');
      await until(`window.__smoke.attr('data-focus') === null`, 'the focus cleared');
      await untilFiltered(null);
      const figuresWhole = await lensFigures();
      check(
        'on a filtered map a group counts the work of the boxes inside it that Filter leaves out; on the whole map, at the same level, it has no strip',
        filteredStrip !== undefined &&
          filteredStrip.heat > 0 &&
          (await attr('data-lod')) === 'subcomponents' &&
          figuresWhole.strips.every((strip) => strip.id !== 'backoffice'),
        { filteredStrip, whole: heatOf(figuresWhole, 'backoffice') },
      );

      check(
        'nothing failed in the page and nothing broke its security policy while boxes were moved and resized by hand',
        pageErrors.length === handStart.errors && violations.length === handStart.violations,
        {
          errors: pageErrors.slice(handStart.errors, handStart.errors + 5),
          violations: violations.slice(handStart.violations, handStart.violations + 5),
        },
      );

      // Back to the state the block started from.
      await press('Escape', { keyCode: 27 });
      await untilSelection(null);
      if ((await attr('data-focus-mode')) !== handStart.focusMode) {
        await click('#focus-mode');
        await until(
          `window.__smoke.attr('data-focus-mode') === '${handStart.focusMode}'`,
          'Focus mode as before',
        );
      }
      await setSetting('heat', handStart.heat === 'true');
      await setSetting('progress', handStart.progress === 'true');
      await setSetting('compact-collapsed', handStart.shrink === 'true');
      await closeUp(handStart.closeGaps === 'true');
      await showRows(handStart.rows === 'true');
      await evaluate(
        `document.querySelector('#views-list li[data-view-name="${HAND_VIEW}"] .views-apply').click()`,
      );
      await until(
        `window.__smoke.attr('data-lod-mode') === ${JSON.stringify(handStart.lodMode)} && window.__smoke.attr('data-collapsed-count') === ${JSON.stringify(handStart.collapsed)} && window.__smoke.attr('data-lines-laid-out') === 'true'`,
        'the view the block started from',
      );
      await settled();
      await evaluate(
        `document.querySelector('#views-list li[data-view-name="${HAND_VIEW}"] .views-delete').click()`,
      );
      await until(
        `window.__smoke.count('#views-list li[data-view-name="${HAND_VIEW}"]') === 0`,
        'the view to come back to deleted',
      );
      if ((await attr('data-panel-tab')) !== handStart.tab) {
        await click(`#tab-${handStart.tab}`);
        await until(
          `window.__smoke.attr('data-panel-tab') === '${handStart.tab}'`,
          'the tab shown before',
        );
      }
      if ((await attr('data-panel-collapsed')) !== handStart.panelCollapsed) {
        await togglePanel(handStart.panelCollapsed === 'true');
      }
    }

    // --- Export: the map as a PNG, an SVG and a page of its own --------------------------------
    // In a block: its names are of use to no other part of the run.
    {
      /** @typedef {{ r: number, g: number, b: number, a: number }} Colour */
      /** @typedef {{ status: Record<string, string>, file: Buffer | undefined }} Exported */
      /**
       * A point of the map where a picture and the screen show a flat colour (`probes()` in the
       * page): in pixels of the map, and on the screen from the corner of the canvas.
       * @typedef {object} Probe
       * @property {string} id
       * @property {string} kind
       * @property {string} [band]
       * @property {number} x
       * @property {number} y
       * @property {[number, number]} screen
       * @property {boolean} clear
       */
      /**
       * A box in the SVG and on the canvas: x, y, width, height, and the two ends of its header.
       * @typedef {object} PlacedBox
       * @property {string} id
       * @property {number[]} picture
       * @property {number[] | null} canvas
       * @property {number[] | null} header
       */
      /**
       * The name of a box on the canvas and in the SVG (`names()` in the page).
       * @typedef {object} DrawnName
       * @property {string} id
       * @property {string} name
       * @property {boolean} cut
       * @property {number} room
       * @property {string | null} picture
       * @property {number} length
       * @property {number} middle
       * @property {{ width: number, middle: number }} range
       */
      /**
       * The opacity of a box, a line or a label in the SVG and on the canvas.
       * @typedef {object} Mark
       * @property {string} id
       * @property {number} picture
       * @property {number | null} canvas
       * @property {boolean} dimmed
       * @property {boolean} faded
       */

      // What the block starts from, to come back to at its end.
      const EXPORT_KEY = 'architecture-map.export';
      const EXPORT_START_VIEW = 'Before the exports';
      const exportStart = {
        tab: await attr('data-panel-tab'),
        panelCollapsed: await attr('data-panel-collapsed'),
        heat: await attr('data-heat'),
        progress: await attr('data-progress'),
        onDemand: await attr('data-edges-on-demand'),
        shrink: await attr('data-compact-collapsed'),
        focusMode: await attr('data-focus-mode'),
        rows: await attr('data-show-rows'),
        closeGaps: await attr('data-close-gaps'),
        colorBy: await attr('data-color-by'),
        storyMode: await attr('data-story-mode'),
        hiddenKinds: await attr('data-hidden-kinds'),
        lodMode: await attr('data-lod-mode'),
        collapsed: await attr('data-collapsed-count'),
        stored: /** @type {string | null} */ (
          await evaluate(`localStorage.getItem('${EXPORT_KEY}')`)
        ),
        keys: /** @type {string[]} */ (await evaluate(`Object.keys(localStorage)`)),
        requests: requests.length,
        violations: violations.length,
      };
      /** Errors the page reports during the exports; none is expected. @type {string[]} */
      const exportErrors = [];
      client.on('Runtime.exceptionThrown', (params) => {
        exportErrors.push(
          params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? '?',
        );
      });
      client.on('Runtime.consoleAPICalled', (params) => {
        if (params.type === 'error') {
          exportErrors.push(
            String(params.args?.[0]?.value ?? params.args?.[0]?.description ?? '?'),
          );
        }
      });

      // The files go into a folder of the run. A headless browser that is not told where saves
      // into the Downloads folder of whoever runs the test: without the folder, nothing is
      // exported at all.
      scratch ??= await mkdtemp(path.join(os.tmpdir(), 'arch-map-smoke-data-'));
      const exportsDir = path.join(scratch, 'exports');
      await mkdir(exportsDir, { recursive: true });
      const downloads = { behavior: 'allow', downloadPath: exportsDir };
      const downloadsSet = await client.send('Browser.setDownloadBehavior', downloads).then(
        () => true,
        () =>
          client.send('Page.setDownloadBehavior', downloads).then(
            () => true,
            () => false,
          ),
      );
      if (!downloadsSet) {
        throw new Error('the browser takes no folder for its downloads: nothing is exported');
      }

      /**
       * Asks the page about the exported files (`EXPORT_HELPERS`). The call may carry a whole
       * file: an error names the start of it only.
       * @param {string} call
       * @returns {Promise<any>}
       */
      const exportPage = (call) =>
        evaluate(`${EXPORT_HELPERS}.${call}`).catch((error) => {
          throw new Error(
            `page error in ${call.slice(0, 60)}: ${String(error.message).slice(-80)}`,
          );
        });
      /**
       * Clicks one of the three buttons and waits for the export to end: the text and the
       * attributes of its status and, when a file was saved, that file — complete, with the
       * number of bytes the status states. A file of that name from an earlier export is removed
       * first: the browser would number the new one.
       * @param {'png' | 'svg' | 'html'} format @param {string} [base]
       * @returns {Promise<Exported>}
       */
      const exported = async (format, base = 'architecture') => {
        const counted = `Number(document.querySelector('#export-status')?.dataset.count ?? 0)`;
        /** @type {number} */
        const before = await evaluate(counted);
        await rm(path.join(exportsDir, `${base}-map.${format}`), { force: true });
        // While a layout is on its way the buttons wait.
        await until(
          `document.querySelector('#export-${format}')?.disabled === false`,
          `the ${format} button to be ready`,
        );
        await click(`#export-${format}`);
        await until(
          `${counted} > ${before} && document.querySelector('#export-status').dataset.state !== 'working'`,
          `the ${format} export to end`,
        );
        /** @type {Record<string, string>} */
        const status = await evaluate(`(() => {
          const status = document.querySelector('#export-status');
          return { text: status.textContent, ...status.dataset };
        })()`);
        if (status.state !== 'saved') return { status, file: undefined };
        const saved = path.join(exportsDir, status.name ?? '');
        const file = await waitFor(async () => {
          const data = await readFile(saved).catch(() => undefined);
          return data !== undefined && data.length === Number(status.bytes) ? data : undefined;
        }, `the file ${status.name} with ${status.bytes} bytes`);
        return { status, file };
      };
      /**
       * Exports the SVG and reads it into the page: what the checks ask about from then on. An
       * export that saves nothing where a picture is expected ends the run.
       * @param {string} [base]
       */
      const savedSvg = async (base) => {
        const { status, file } = await exported('svg', base);
        if (file === undefined) throw new Error(`no SVG was saved: ${status.text}`);
        const svg = file.toString('utf8');
        const read = await exportPage(`load(${JSON.stringify(svg)})`);
        return { status, file, svg, read };
      };
      /**
       * Width and height a PNG file states, or null for a file that is no PNG.
       * @param {Buffer | undefined} file
       */
      const pngSizeOf = (file) =>
        file !== undefined &&
        file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        file.toString('latin1', 12, 16) === 'IHDR'
          ? { width: file.readUInt32BE(16), height: file.readUInt32BE(20) }
          : null;
      /** Puts a PNG into the page under a name. @param {string} name @param {string} base64 */
      const showPicture = (name, base64) =>
        exportPage(`picture(${JSON.stringify(name)}, ${JSON.stringify(base64)})`);
      /**
       * The pixels of a picture in the page at whole points.
       * @param {string} name @param {number[][]} points @returns {Promise<number[][]>}
       */
      const pixelsOf = (name, points) =>
        exportPage(`pixels(${JSON.stringify(name)}, ${JSON.stringify(points)})`);
      /** @param {number} a @param {number} b @param {number} by */
      const near = (a, b, by) => Math.abs(a - b) <= by;
      /**
       * Whether two lists of numbers are the same within `by`.
       * @param {number[]} a @param {number[]} b @param {number} by
       */
      const nearAll = (a, b, by) =>
        a.length === b.length && a.every((value, i) => near(value, b[i] ?? NaN, by));
      /**
       * Whether two colours are the same: each channel within `by` of 255, the alpha within 0.01.
       * @param {Colour | null | undefined} a @param {Colour | null | undefined} b
       * @param {number} [by]
       */
      const sameColour = (a, b, by = 1) =>
        !!a &&
        !!b &&
        near(a.r, b.r, by) &&
        near(a.g, b.g, by) &&
        near(a.b, b.b, by) &&
        near(a.a, b.a, 0.01);
      /**
       * A colour over an opaque one.
       * @param {Colour} top @param {Colour} below @returns {Colour}
       */
      const over = (top, below) => ({
        r: top.r * top.a + below.r * (1 - top.a),
        g: top.g * top.a + below.g * (1 - top.a),
        b: top.b * top.a + below.b * (1 - top.a),
        a: 1,
      });
      /** A pixel as a colour. @param {number[] | undefined} pixel @returns {Colour | null} */
      const colourOf = (pixel) =>
        pixel === undefined
          ? null
          : {
              r: pixel[0] ?? NaN,
              g: pixel[1] ?? NaN,
              b: pixel[2] ?? NaN,
              a: (pixel[3] ?? NaN) / 255,
            };
      /** The properties of the page the pictures are probed for. */
      const PALETTE = [
        '--bg',
        '--leaf-bg',
        '--domain-header-bg',
        '--band-gutter',
        '--band-even',
        '--band-odd',
        '--node-selected',
      ];
      /** @returns {Promise<Record<string, Colour>>} */
      const paletteNow = () => exportPage(`palette(${JSON.stringify(PALETTE)})`);
      /** The four choices as the controls show them. */
      const choicesShown = () =>
        evaluate(`({
          area: document.querySelector('#export-area')?.value ?? null,
          scheme: document.querySelector('#export-scheme')?.value ?? null,
          scale: document.querySelector('#export-scale')?.value ?? null,
          caption: document.querySelector('#export-caption')?.checked ?? null,
        })`);
      /**
       * Makes the four choices, each as a pick from its list or a click on its box would.
       * @param {{ area?: string, scheme?: string, scale?: string, caption?: boolean }} choices
       */
      const choose = async (choices) => {
        for (const name of /** @type {const} */ (['area', 'scheme', 'scale'])) {
          const value = choices[name];
          if (value !== undefined) await chooseOption(`#export-${name}`, value);
        }
        if (choices.caption !== undefined) await setSetting('export-caption', choices.caption);
      };
      /** Waits until nothing on the page is fading in or out. */
      const calm = () =>
        until(
          `document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== 'running')`,
          'the page at rest',
        );
      /**
       * What of the canvas the SVG last read does not hold as it is drawn — boxes, shown edges
       * and labels by their IDs, each once, and as many row bands; a name that is empty or no
       * beginning of the name of its box; an edge without its line or its head; a label with
       * other words — and how many of each it holds.
       */
      const contentProblems = async () => {
        const held = await exportPage('contents()');
        /** @type {string[]} */
        const problems = [];
        for (const what of ['boxes', 'edges', 'labels']) {
          /** @type {{ picture: string[], canvas: string[] }} */
          const { picture, canvas } = held[what];
          if (!same([...picture].sort(), [...canvas].sort())) {
            const missing = canvas.filter((id) => !picture.includes(id));
            const extra = picture.filter((id) => !canvas.includes(id));
            problems.push(
              `${what}: ${JSON.stringify({ missing, extra, written: picture.length })}`,
            );
          }
        }
        if (held.bands.picture !== held.bands.canvas) {
          problems.push(`row bands: ${held.bands.picture} of ${held.bands.canvas}`);
        }
        for (const box of held.names) {
          const first = box.first.endsWith('…') ? box.first.slice(0, -1) : box.first;
          if (box.first === '' || box.name === null || !box.name.startsWith(first)) {
            problems.push(`name of ${box.id}: "${box.first}" for "${box.name}"`);
          }
        }
        for (const edge of held.parts) {
          if (edge.lines !== 1 || edge.heads !== 1) problems.push(`parts of ${edge.id}`);
        }
        for (const label of held.words) {
          if (label.picture !== label.canvas) problems.push(`words of the label of ${label.id}`);
        }
        return {
          problems,
          boxes: /** @type {number} */ (held.boxes.picture.length),
          edges: /** @type {number} */ (held.edges.picture.length),
          labels: /** @type {number} */ (held.labels.picture.length),
          bands: /** @type {number} */ (held.bands.picture),
        };
      };
      /**
       * What the SVG last read has elsewhere than the canvas: a box (its corner and its size
       * within half a pixel), the line of an edge (the eight numbers of its path within one), a
       * label (the middle of its box within two pixels — the canvas puts its text on whole screen
       * pixels, which at a zoom below one is more than a map pixel —, its width within two, its
       * height within one and a half).
       */
      const placeProblems = async () => {
        const placed = await exportPage('places()');
        /** @type {string[]} */
        const problems = [];
        for (const box of placed.boxes) {
          if (!box.canvas || !nearAll(box.picture, box.canvas, 0.5)) {
            problems.push(`${box.id}: ${JSON.stringify([box.picture, box.canvas])}`);
          }
        }
        for (const edge of placed.edges) {
          if (!edge.canvas || edge.picture.length !== 8 || !nearAll(edge.picture, edge.canvas, 1)) {
            problems.push(`${edge.id}: ${JSON.stringify([edge.picture, edge.canvas])}`);
          }
        }
        for (const label of placed.labels) {
          const [x, y, width, height] = label.picture;
          const [cx, cy, cWidth, cHeight] = label.canvas ?? [];
          if (
            !near(x, cx, 2) ||
            !near(y, cy, 2) ||
            !near(width, cWidth, 2) ||
            !near(height, cHeight, 1.5)
          ) {
            problems.push(`label of ${label.id}: ${JSON.stringify([label.picture, label.canvas])}`);
          }
        }
        return {
          problems,
          boxes: /** @type {number} */ (placed.boxes.length),
          edges: /** @type {number} */ (placed.edges.length),
          labels: /** @type {number} */ (placed.labels.length),
          /** @type {PlacedBox[]} */
          all: placed.boxes,
        };
      };
      /**
       * What the SVG last read colours otherwise than the canvas (the background of a box, its
       * header and its name; the colour, the width and the dashes of a line), and the kinds of
       * boxes and of edges that were compared.
       */
      const colourProblems = async () => {
        const coloured = await exportPage('colours()');
        /** @type {string[]} */
        const problems = [];
        for (const box of coloured.boxes) {
          for (const part of ['box', 'header', 'name']) {
            /** @type {[Colour | null, Colour | null] | null} */
            const pair = box[part];
            // A leaf has no header.
            if (pair === null && part === 'header') continue;
            if (pair === null || !sameColour(pair[0], pair[1])) {
              problems.push(`${part} of ${box.id}: ${JSON.stringify(pair)}`);
            }
          }
        }
        for (const edge of coloured.edges) {
          if (
            !sameColour(edge.stroke[0], edge.stroke[1]) ||
            !near(edge.width[0], edge.width[1] ?? NaN, 0.01) ||
            edge.dash[1] === null ||
            !nearAll(edge.dash[0], edge.dash[1], 0.01)
          ) {
            problems.push(
              `line of ${edge.id}: ${JSON.stringify([edge.stroke, edge.width, edge.dash])}`,
            );
          }
        }
        return {
          problems,
          boxes: /** @type {string[]} */ ([
            ...new Set(coloured.boxes.map((/** @type {{ kind: string }} */ box) => box.kind)),
          ]),
          edges: /** @type {string[]} */ ([
            ...new Set(coloured.edges.map((/** @type {{ kind: string }} */ edge) => edge.kind)),
          ]),
        };
      };
      /**
       * The names of the SVG last read against the canvas. A name the canvas cuts ends in "…",
       * is at most as long as its room and more than half of it; every other is whole, as long
       * as the canvas draws it and as high up, each within a pixel and a half.
       */
      const nameProblems = async () => {
        /** @type {DrawnName[]} */
        const names = await exportPage('names()');
        /** @type {string[]} */
        const problems = [];
        for (const name of names) {
          const right = name.cut
            ? name.picture !== null &&
              name.picture.endsWith('…') &&
              name.length <= name.room + 0.5 &&
              name.length > name.room / 2
            : name.picture === name.name &&
              near(name.length, name.range.width, 1.5) &&
              near(name.middle, name.range.middle, 1.5);
          if (!right) problems.push(`${name.id}: ${JSON.stringify(name)}`);
        }
        return {
          problems,
          cut: names.filter((name) => name.cut).map((name) => name.id),
          whole: names.filter((name) => !name.cut).map((name) => name.id),
        };
      };
      /**
       * Drags the empty canvas by (dx, dy), or as far that way as the canvas allows.
       * @param {number} dx @param {number} dy
       */
      const pan = async (dx, dy) => {
        const plan = await evaluate(`window.__smoke.panPlan(${dx}, ${dy})`);
        if (plan === null) throw new Error('no empty canvas to drag the map by');
        await drag(plan.from, plan.to);
        await settled();
      };

      // Start: nothing selected or focused, every lens off, every group open, rows, the
      // Components level, the whole map in view. A saved view keeps the way back.
      await press('Escape', { keyCode: 27 });
      await untilSelection(null);
      if ((await attr('data-focus')) !== null) {
        await chooseOption('#focus-select', '');
        await until(`window.__smoke.attr('data-focus') === null`, 'no focus before the exports');
      }
      await untilFiltered(null);
      await saveView(EXPORT_START_VIEW);
      await until(
        `window.__smoke.count('#views-list li[data-view-name="${EXPORT_START_VIEW}"]') === 1`,
        'the view to come back to after the exports',
      );
      if (exportStart.focusMode !== 'focus') {
        await click('#focus-mode');
        await until(`window.__smoke.attr('data-focus-mode') === 'focus'`, 'Focus mode');
      }
      await closeUp(false);
      await showRows(true);
      for (const id of ['heat', 'progress', 'edges-on-demand', 'compact-collapsed']) {
        await setSetting(id, false);
      }
      if (exportStart.colorBy !== 'none') {
        await chooseOption('#color-by', 'none');
        await until(`window.__smoke.attr('data-color-by') === 'none'`, 'colour by nothing');
      }
      if (exportStart.storyMode !== 'stories') await chooseStories('stories');
      for (const kind of (exportStart.hiddenKinds ?? '').split(' ').filter(Boolean)) {
        await click(`#kind-filters [data-kind="${kind}"]`);
      }
      await until(`window.__smoke.attr('data-hidden-kinds') === ''`, 'every kind of edge shown');
      await click('#expand-all');
      await until(`window.__smoke.attr('data-collapsed-count') === '0'`, 'everything expanded');
      await pinLod('components');
      await fit();

      // The section: on the Files tab while a map is drawn, with the choices nobody has made yet.
      await showControl('#export');
      const section = await evaluate(`(() => {
        const options = (id) => [...document.querySelectorAll(id + ' option')].map((option) => option.value + ' ' + option.textContent);
        return {
          sections: document.querySelectorAll('#export').length,
          tab: document.querySelector('#export')?.closest('[role="tabpanel"]')?.id ?? null,
          title: window.__smoke.text('#export-title'),
          buttons: ['png', 'svg', 'html'].map((format) => {
            const button = document.querySelector('#export-' + format);
            return button ? button.textContent + ' ' + button.disabled + ' ' + button.title : null;
          }),
          area: options('#export-area'),
          scheme: options('#export-scheme'),
          scale: options('#export-scale'),
          scaleTitle: document.querySelector('#export-scale')?.title ?? null,
          caption: document.querySelector('#export-caption')?.closest('label')?.textContent ?? null,
          note: window.__smoke.text('#export-note'),
          status: document.querySelectorAll('#export-status').length,
          hint: document.querySelectorAll('#export-hint').length,
        };
      })()`);
      const choicesAtFirst = await choicesShown();
      check(
        'the Files tab has an Export section: three buttons, the four choices as nobody has made them yet, and its note',
        exportStart.stored === null &&
          section.sections === 1 &&
          section.tab === 'panel-files' &&
          section.title === 'Export' &&
          same(section.buttons, [
            'PNG false Save a picture of the map (PNG)',
            'SVG false Save the map as a vector drawing: shapes and text, sharp at any size (SVG)',
            'HTML false Save the map as a web page that needs nothing else and lists the boxes as text (HTML)',
          ]) &&
          same(section.area, ['map Whole map', 'view What is on screen']) &&
          same(section.scheme, ['screen As on screen', 'light Light', 'dark Dark']) &&
          same(section.scale, ['1 1×', '2 2×', '3 3×']) &&
          section.scaleTitle === 'Pixels of the PNG per pixel of the map' &&
          section.caption === 'Title and legend' &&
          same(choicesAtFirst, { area: 'map', scheme: 'screen', scale: '2', caption: true }) &&
          section.note ===
            'The map as it is drawn now: level of detail, focus, colours, work items and what is selected. A PNG is a fixed picture; SVG stays sharp at any size; the HTML page opens in any browser.' &&
          section.status === 0 &&
          section.hint === 0,
        { stored: exportStart.stored, section, choicesAtFirst },
      );

      // The SVG of the whole map at the Components level, with its title and legend.
      const light = await paletteNow();
      const plain = await savedSvg();
      const plainImage = await exportPage('image()');
      const refused = [
        '<style',
        ' style=',
        '<script',
        '<image',
        '<use',
        '<foreignObject',
        '<filter',
        'href=',
        'NaN',
      ].filter((part) => plain.svg.includes(part));
      check(
        'SVG: the file is architecture-map.svg with the bytes and the size the status states, one plain picture that loads as an image',
        plain.status.text === 'Saved architecture-map.svg.' &&
          plain.status.name === 'architecture-map.svg' &&
          plain.status.format === 'svg' &&
          plain.file.length === Number(plain.status.bytes) &&
          plain.read.error === null &&
          plain.read.root === 'svg' &&
          plain.read.width === Number(plain.status.width) &&
          plain.read.height === Number(plain.status.height) &&
          plain.read.width > 0 &&
          plain.read.height > 0 &&
          plain.read.role === 'img' &&
          plain.read.title === 'architecture.yaml' &&
          typeof plain.read.desc === 'string' &&
          plain.read.desc.includes(
            `${plain.status.nodes} boxes and ${plain.status.edges} edges. Level: Components`,
          ) &&
          refused.length === 0 &&
          plainImage.width === plain.read.width &&
          plainImage.height === plain.read.height,
        {
          status: plain.status,
          read: { ...plain.read, nodes: undefined, edges: undefined, texts: undefined },
          refused,
          plainImage,
        },
      );
      const plainHeld = await contentProblems();
      check(
        'SVG: it holds every box, shown edge, label and row band of the canvas, each once: every box with its name, every edge with its line and its head, every label with its words',
        plainHeld.problems.length === 0 &&
          plainHeld.boxes > 10 &&
          plainHeld.edges > 5 &&
          plainHeld.labels > 0 &&
          plainHeld.bands > 0 &&
          plainHeld.boxes === Number(plain.status.nodes) &&
          plainHeld.edges === Number(plain.status.edges),
        { ...plainHeld, problems: plainHeld.problems.slice(0, 5), status: plain.status },
      );
      const plainPlaced = await placeProblems();
      check(
        'SVG: boxes, edges and labels are where the canvas has them',
        plainPlaced.problems.length === 0 &&
          plainPlaced.boxes === plainHeld.boxes &&
          plainPlaced.edges === plainHeld.edges &&
          plainPlaced.labels === plainHeld.labels,
        { problems: plainPlaced.problems.slice(0, 5), boxes: plainPlaced.boxes },
      );
      const plainColours = await colourProblems();

      // The PNG of the same map: twice the picture, and the colours of the page where it is flat.
      /** @type {Probe[]} */
      const plainProbes = (await exportPage('probes()')).filter(
        (/** @type {Probe} */ probe) =>
          probe.clear && ['leaf', 'domain header', 'gutter'].includes(probe.kind),
      );
      const png = await exported('png');
      const pngSize = pngSizeOf(png.file);
      check(
        'PNG: the file is architecture-map.png, a PNG of twice the picture, as large as the status states',
        png.status.state === 'saved' &&
          png.status.name === 'architecture-map.png' &&
          png.status.format === 'png' &&
          pngSize !== null &&
          pngSize.width === Number(png.status.width) &&
          pngSize.height === Number(png.status.height) &&
          pngSize.width === Math.floor(plain.read.width * 2) &&
          pngSize.height === Math.floor(plain.read.height * 2) &&
          png.status.reduced === 'false' &&
          png.status.scale === '2.0000' &&
          png.status.text ===
            `Saved architecture-map.png (${pngSize.width} × ${pngSize.height} px).`,
        { status: png.status, pngSize, svg: [plain.read.width, plain.read.height] },
      );
      if (png.file !== undefined && pngSize !== null) {
        await showPicture('png', png.file.toString('base64'));
        const [shiftX, shiftY] = /** @type {[number, number]} */ (plain.read.shift);
        const corners = await pixelsOf('png', [
          [0, 0],
          [pngSize.width - 1, pngSize.height - 1],
        ]);
        const seen = await pixelsOf(
          'png',
          plainProbes.map((probe) => [
            Math.floor((probe.x + shiftX) * 2),
            Math.floor((probe.y + shiftY) * 2),
          ]),
        );
        /** The colour of the page at a probe. @param {Probe} probe @returns {Colour | undefined} */
        const expected = (probe) => {
          if (probe.kind === 'leaf') return light['--leaf-bg'];
          if (probe.kind === 'domain header') return light['--domain-header-bg'];
          const [gutter, band, bg] = [
            light['--band-gutter'],
            light[`--band-${probe.band}`],
            light['--bg'],
          ];
          return gutter && band && bg ? over(gutter, over(band, bg)) : undefined;
        };
        const wrong = plainProbes.flatMap((probe, i) =>
          sameColour(colourOf(seen[i]), expected(probe), 3)
            ? []
            : [`${probe.kind} ${probe.id}: ${JSON.stringify([seen[i], expected(probe)])}`],
        );
        const probed = Object.fromEntries(
          ['leaf', 'domain header', 'gutter'].map((kind) => [
            kind,
            plainProbes.filter((probe) => probe.kind === kind).length,
          ]),
        );
        check(
          'PNG: the corners, leaves, domain headers and row gutters have the colours the page computes for them',
          corners.every((corner) => sameColour(colourOf(corner), light['--bg'], 3)) &&
            wrong.length === 0 &&
            Object.values(probed).every((count) => count > 0),
          { corners, bg: light['--bg'], probed, wrong: wrong.slice(0, 5) },
        );
        await exportPage('forget()');
      }

      // The page of the same map, read as a file.
      const html = await exported('html');
      const htmlText = html.file?.toString('utf8') ?? '';
      const htmlRead = await exportPage(`page(${JSON.stringify(htmlText)})`);
      check(
        'HTML: the file is architecture-map.html, a page without a script, a handler or an address, that lists the boxes and the edges of the picture',
        html.status.text === 'Saved architecture-map.html.' &&
          html.status.name === 'architecture-map.html' &&
          htmlText.startsWith('<!doctype html>') &&
          !/<script/i.test(htmlText) &&
          htmlRead.scripts === 0 &&
          htmlRead.handlers.length === 0 &&
          htmlRead.addresses.length === 0 &&
          htmlRead.links.length > 1 &&
          htmlRead.links.every(
            (/** @type {string} */ href) => href === 'data:,' || href.startsWith('#'),
          ) &&
          same(htmlRead.drawn, plain.read.nodes) &&
          same([...htmlRead.listed].sort(), [...plain.read.nodes].sort()) &&
          htmlRead.rows === plain.read.edges.length,
        {
          status: html.status,
          start: htmlText.slice(0, 20),
          handlers: htmlRead.handlers,
          addresses: htmlRead.addresses,
          links: htmlRead.links.filter((/** @type {string} */ href) => !href.startsWith('#')),
          listed: htmlRead.listed.length,
          rows: htmlRead.rows,
        },
      );

      // Colours. The open components are at the Subcomponents level, looked at without a
      // colouring (with one, every box that has the attribute is tinted); by an attribute, the
      // tint of the boxes is the browser's own mix.
      await pinLod('subcomponents');
      await savedSvg();
      const openColours = await colourProblems();
      await pinLod('components');
      await fit();
      await chooseOption('#color-by', 'owner');
      await until(`window.__smoke.attr('data-color-by') === 'owner'`, 'colour by owner');
      await savedSvg();
      const tintedColours = await colourProblems();
      const tintedKey = await exportPage('key()');
      const boxKinds = [
        ...new Set([...plainColours.boxes, ...tintedColours.boxes, ...openColours.boxes]),
      ];
      const lineKinds = [
        ...new Set([...plainColours.edges, ...tintedColours.edges, ...openColours.edges]),
      ];
      check(
        'SVG: boxes, headers, names and lines have the colours the browser computes on the canvas, with and without Colour by',
        plainColours.problems.length === 0 &&
          tintedColours.problems.length === 0 &&
          openColours.problems.length === 0 &&
          ['leaf', 'open domain', 'open component', 'closed group', 'tinted leaf'].every((kind) =>
            boxKinds.includes(kind),
          ) &&
          boxKinds.some((kind) => kind.startsWith('tinted') && kind !== 'tinted leaf') &&
          lineKinds.length >= 2,
        {
          boxKinds,
          lineKinds,
          problems: [
            ...plainColours.problems,
            ...tintedColours.problems,
            ...openColours.problems,
          ].slice(0, 5),
        },
      );

      // Title and legend, with Colour by: the name of the file, and the key of what is drawn.
      const drawnKinds = /** @type {string[]} */ (tintedKey.canvas.kinds);
      check(
        'Title and legend: the heading starts with the name of the file, and the key has the chips of the colour legend, in its order and its colours, and the kinds of edge that are drawn',
        tintedKey.headings === 1 &&
          tintedKey.legends === 1 &&
          tintedKey.heading[0] === 'architecture.yaml' &&
          tintedKey.heading.join(' ').includes('Level: Components · Colour by Owner') &&
          tintedKey.chips.length > 1 &&
          tintedKey.chips.length === tintedKey.canvas.chips.length &&
          tintedKey.chips.every(
            (/** @type {{ value: string, colour: Colour }} */ chip, /** @type {number} */ i) =>
              chip.value === tintedKey.canvas.chips[i].value &&
              sameColour(chip.colour, tintedKey.canvas.chips[i].colour),
          ) &&
          drawnKinds.length >= 2 &&
          same(tintedKey.kinds, drawnKinds) &&
          same(tintedKey.keys, ['edges', 'colour']),
        tintedKey,
      );
      await click('#kind-filters [data-kind="dataflow"]');
      await until(`window.__smoke.attr('data-hidden-kinds') === 'dataflow'`, 'dataflow hidden');
      await until(
        `window.__smoke.count('.react-flow__edge.arch-edge-dataflow') === 0`,
        'no dataflow edge drawn',
      );
      await savedSvg();
      const withoutKind = await exportPage('key()');
      await click('#kind-filters [data-kind="dataflow"]');
      await until(`window.__smoke.attr('data-hidden-kinds') === ''`, 'dataflow shown again');
      await until(
        `window.__smoke.count('.react-flow__edge.arch-edge-dataflow') > 0`,
        'the dataflow edges drawn again',
      );
      // Heat and progress on as well: their lines in the key, and the marks on the boxes.
      await setSetting('heat', true);
      await setSetting('progress', true);
      await until(
        `window.__smoke.count('.arch-heat-left') > 0 && window.__smoke.count('.arch-progress') > 0`,
        'heat strips and progress bars',
      );
      const framed = await savedSvg();
      const framedKey = await exportPage('key()');
      const lensMarks = await exportPage('lenses()');
      check(
        'Title and legend: a kind of edge that is switched off is not in the key and the note says so; heat and progress have their lines in the key while they are on',
        drawnKinds.includes('dataflow') &&
          !withoutKind.kinds.includes('dataflow') &&
          same(withoutKind.kinds, withoutKind.canvas.kinds) &&
          withoutKind.heading.join(' ').includes('Without dataflow edges') &&
          !tintedKey.heading.join(' ').includes('Without') &&
          same(framedKey.keys, ['edges', 'colour', 'heat', 'progress']) &&
          framedKey.heading.join(' ').includes('Heat by work · Progress'),
        { without: withoutKind.kinds, heading: withoutKind.heading, keys: framedKey.keys },
      );
      /** @type {{ id: string, canvas: [number, string], picture: [number, string] | null }[]} */
      const strips = lensMarks.heat;
      /** @type {{ id: string, canvas: number, picture: number | null }[]} */
      const bars = lensMarks.progress;
      const wrongMarks = [
        ...strips.filter(
          (strip) =>
            strip.picture === null ||
            !near(strip.picture[0], strip.canvas[0], 0.5) ||
            strip.picture[1] !== strip.canvas[1],
        ),
        ...bars.filter((bar) => bar.picture === null || !near(bar.picture, bar.canvas, 0.5)),
      ];
      check(
        'heat and progress: two strips for every strip pair of the canvas, each as tall as on the canvas and with its count, and every bar done as far as on the canvas',
        strips.length > 0 &&
          lensMarks.strips === 2 * strips.length &&
          bars.length > 0 &&
          lensMarks.bars === bars.length &&
          bars.some((bar) => bar.canvas > 0) &&
          wrongMarks.length === 0,
        { strips: lensMarks.strips, bars: lensMarks.bars, wrong: wrongMarks.slice(0, 5) },
      );
      // Without them: the map and its margin alone, in the same state.
      await choose({ caption: false });
      const bare = await savedSvg();
      const bareKey = await exportPage('key()');
      const mapSpan = await evaluate(`(() => {
        const rects = [...document.querySelectorAll('.react-flow__node')].map((el) => el.getBoundingClientRect());
        const zoom = window.__smoke.viewport().zoom;
        return {
          width: (Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left))) / zoom,
          height: (Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.top))) / zoom,
        };
      })()`);
      const headingHeight = framed.read.shift[1] - bare.read.shift[1];
      check(
        'Title and legend off: no heading and no key, and the picture is the map with its margin — what lies between the two in a picture that has them',
        bareKey.headings === 0 &&
          bareKey.legends === 0 &&
          bareKey.keys.length === 0 &&
          headingHeight > 20 &&
          framedKey.legendTop !== null &&
          bare.read.height === framedKey.legendTop - headingHeight &&
          bare.read.height < framed.read.height &&
          bare.read.width <= framed.read.width &&
          bare.read.width >= mapSpan.width + 47 &&
          bare.read.height >= mapSpan.height + 47,
        {
          bare: [bare.read.width, bare.read.height],
          framed: [framed.read.width, framed.read.height],
          headingHeight,
          legendTop: framedKey.legendTop,
          mapSpan,
        },
      );
      await choose({ caption: true });
      await setSetting('heat', false);
      await setSetting('progress', false);
      await chooseOption('#color-by', 'none');
      await until(`window.__smoke.attr('data-color-by') === 'none'`, 'colour by nothing');

      // Shrunk groups: the list of what is inside, as the canvas wraps it.
      await setSetting('compact-collapsed', true);
      await until(
        `window.__smoke.count('.arch-group.arch-compact') > 0 && window.__smoke.attr('data-layout-pending') === 'false' && window.__smoke.attr('data-lines-laid-out') === 'true'`,
        'the map with shrunk groups',
      );
      await settled();
      await savedSvg();
      const shrunkHeld = await contentProblems();
      /** @type {{ id: string, canvas: string, canvasLines: number, lines: string[] | null }[]} */
      const shrunk = await exportPage('shrunk()');
      const spaceless = (/** @type {string} */ words) => words.replace(/\s+/g, '');
      const wrongLists = shrunk.filter(
        (group) =>
          group.lines === null ||
          group.lines.length === 0 ||
          spaceless(group.lines.join(' ')) !== spaceless(group.canvas) ||
          Math.abs(group.lines.length - group.canvasLines) > 1,
      );
      check(
        'SVG: the list of a shrunk group has the words of the canvas, on as many lines or one more or less',
        shrunk.length > 0 && wrongLists.length === 0 && shrunkHeld.problems.length === 0,
        {
          groups: shrunk.length,
          wrong: wrongLists.slice(0, 3),
          held: shrunkHeld.problems.slice(0, 3),
        },
      );
      await setSetting('compact-collapsed', false);
      await until(
        `window.__smoke.count('.arch-group.arch-compact') === 0 && window.__smoke.attr('data-layout-pending') === 'false' && window.__smoke.attr('data-lines-laid-out') === 'true'`,
        'the map with full boxes again',
      );
      await fit();

      // The states of the map. A selected box: its ring, the rest dimmed, and the hint.
      const SELECTION_HINT =
        'The selection is part of the picture: click the empty canvas first for one without it.';
      const ON_DEMAND_HINT = 'Edges on demand: only the edges shown now are in the picture.';
      /**
       * Where the opacities of the SVG last read are not the ones the browser computes on the
       * canvas, and how many boxes the canvas dims and pales.
       */
      const markProblems = async () => {
        await calm();
        const marks = await exportPage('marks()');
        /** @type {Mark[]} */
        const all = [...marks.boxes, ...marks.edges, ...marks.labels];
        /** @type {Mark[]} */
        const boxes = marks.boxes;
        return {
          problems: all
            .filter((mark) => mark.canvas === null || !near(mark.picture, mark.canvas, 0.005))
            .map((mark) => `${mark.id}: ${mark.picture} for ${mark.canvas}`),
          dimmed: boxes.filter((mark) => mark.dimmed && !mark.faded),
          faded: boxes.filter((mark) => mark.faded),
          ringed: /** @type {string[]} */ (marks.ringed),
          selected: /** @type {string[]} */ (marks.selected),
        };
      };
      await click('.react-flow__node[data-id="data.event-store"]');
      await untilSelection('node:data.event-store');
      const selected = await savedSvg();
      const selectionHint = await text('#export-hint');
      const selectedMarks = await markProblems();
      check(
        'a selected box has its ring in the picture and the rest is dimmed as on the canvas; the section says that the selection is part of the picture',
        selectionHint === SELECTION_HINT &&
          same(selectedMarks.ringed, ['data.event-store']) &&
          same(selectedMarks.selected, ['data.event-store']) &&
          selectedMarks.dimmed.length > 0 &&
          selectedMarks.dimmed.every((mark) => mark.picture === 0.3) &&
          selectedMarks.problems.length === 0 &&
          selected.read.texts.join(' ').includes('With the selection'),
        {
          selectionHint,
          ringed: selectedMarks.ringed,
          dimmed: selectedMarks.dimmed.length,
          problems: selectedMarks.problems.slice(0, 5),
        },
      );
      // Edges on demand, with the box still selected: its edges, and no other.
      await setSetting('edges-on-demand', true);
      await until(`window.__smoke.attr('data-edges-held-back') === 'true'`, 'edges on demand');
      const onDemand = await savedSvg();
      const bothHints = await text('#export-hint');
      const demandHeld = await contentProblems();
      const edgesDrawn = await countOf('.react-flow__edge');
      await press('Escape', { keyCode: 27 });
      await untilSelection(null);
      const demandHint = await text('#export-hint');
      check(
        'edges on demand: only the edges shown are in the picture, and the section says so, beside the selection while there is one',
        bothHints === `${SELECTION_HINT} ${ON_DEMAND_HINT}` &&
          demandHint === ON_DEMAND_HINT &&
          demandHeld.problems.length === 0 &&
          demandHeld.edges > 0 &&
          demandHeld.edges < edgesDrawn &&
          onDemand.read.texts.join(' ').includes('Edges on demand: only the edges shown'),
        {
          bothHints,
          demandHint,
          edges: demandHeld.edges,
          edgesDrawn,
          problems: demandHeld.problems.slice(0, 5),
        },
      );
      await setSetting('edges-on-demand', false);
      await until(`window.__smoke.attr('data-edges-held-back') === 'false'`, 'every edge again');
      // A focus pales the rest; in Filter mode the picture is the reduced map.
      await chooseOption('#focus-select', 'flow:telemetry-to-dashboards');
      await until(
        `window.__smoke.attr('data-focus') === 'flow:telemetry-to-dashboards'`,
        'the focus on the flow',
      );
      await settled();
      const focused = await savedSvg();
      const focusMarks = await markProblems();
      check(
        'a focus: what it leaves out is paled in the picture as on the canvas',
        focusMarks.faded.length > 0 &&
          focusMarks.faded.every((mark) => mark.picture === 0.14) &&
          focusMarks.problems.length === 0 &&
          focused.read.texts.join(' ').includes('Focus: the rest is paled'),
        { faded: focusMarks.faded.length, problems: focusMarks.problems.slice(0, 5) },
      );
      const wholeBoxes = focused.read.nodes.length;
      await click('#focus-mode');
      await untilFiltered('flow:telemetry-to-dashboards');
      const filtered = await savedSvg();
      const filteredHeld = await contentProblems();
      check(
        'Filter: the picture is the map reduced to the focus',
        filteredHeld.problems.length === 0 &&
          filteredHeld.boxes > 0 &&
          filteredHeld.boxes < wholeBoxes &&
          filtered.read.texts.join(' ').includes('Filtered to the focus'),
        { boxes: filteredHeld.boxes, wholeBoxes, problems: filteredHeld.problems.slice(0, 5) },
      );
      await click('#focus-mode');
      await until(`window.__smoke.attr('data-focus-mode') === 'focus'`, 'Focus mode again');
      await chooseOption('#focus-select', '');
      await until(`window.__smoke.attr('data-focus') === null`, 'the focus cleared');
      await untilFiltered(null);
      await press('Escape', { keyCode: 27 });
      await untilSelection(null);
      await fit();

      // By hand: a domain dragged down by its header leaves the bounds of the map, and the
      // picture grows by as much. Nothing of a grip or a handle is in a file.
      await choose({ caption: false });
      const beforeMove = await savedSvg();
      /** @type {string} */
      const movedId = (await exportPage('outermost()')).bottom.id;
      await centreOn(movedId);
      await click('#unlock-positions');
      await until(
        `window.__smoke.attr('data-positions-unlocked') === 'true'`,
        'unlocked positions',
      );
      const grabAt = await headerGrip(movedId);
      await drag(grabAt, { x: grabAt.x, y: grabAt.y + 160 });
      await until(`window.__smoke.attr('data-moved-count') === '1'`, `${movedId} moved by hand`);
      await settled();
      await savedSvg();
      const unlockedHeld = await contentProblems();
      // Where groups can be resized: the right edge of one dragged outwards.
      /** @type {{ id: string, x: number, y: number, zoom: number } | null} */
      const handle = await exportPage('resizeHandle()');
      if (handle !== null) {
        const widthOf = `document.querySelector('.react-flow__node[data-id="${handle.id}"]').offsetWidth`;
        /** @type {number} */
        const widthBefore = await evaluate(widthOf);
        await drag({ x: handle.x, y: handle.y }, { x: handle.x + 60, y: handle.y });
        const wider = await eventually(`${widthOf} > ${widthBefore} + 20`, 'the group resized');
        await settled();
        await savedSvg();
        const resizedPlaced = await placeProblems();
        const resized = resizedPlaced.all.find((box) => box.id === handle.id);
        check(
          'a group resized by hand is as large in the picture as on the canvas, and its header ends at its new width',
          wider &&
            resizedPlaced.problems.length === 0 &&
            resized !== undefined &&
            resized.header !== null &&
            (resized.picture[2] ?? NaN) > widthBefore + 20 &&
            // The header lies inside the border: as far from the right edge as from the left.
            near(
              (resized.header[0] ?? NaN) + (resized.header[1] ?? NaN),
              resized.picture[2] ?? NaN,
              0.5,
            ),
          { handle, widthBefore, resized, problems: resizedPlaced.problems.slice(0, 5) },
        );
      }
      await click('#unlock-positions');
      await until(`window.__smoke.attr('data-positions-unlocked') === 'false'`, 'locked positions');
      const afterMove = await savedSvg();
      const movedPlaced = await placeProblems();
      const movedBox = movedPlaced.all.find((box) => box.id === movedId);
      // The lower end of the picture before the move, and of the dragged box now, in map pixels.
      const boundBefore = beforeMove.read.height - beforeMove.read.shift[1];
      const boxBottom = (movedBox?.picture[1] ?? NaN) + (movedBox?.picture[3] ?? NaN);
      const grown = afterMove.read.height - beforeMove.read.height;
      check(
        'while the positions are unlocked the picture holds the boxes of the canvas and nothing else',
        // The boxes of the picture are held against those of the canvas; the plain picture was
        // taken at another level of detail, so its count says nothing here.
        unlockedHeld.problems.length === 0 && unlockedHeld.boxes > 0,
        { boxes: unlockedHeld.boxes, problems: unlockedHeld.problems.slice(0, 5) },
      );
      check(
        'a box moved by hand is where it was dropped in the picture, and the picture is as much larger as the box left the old bounds',
        movedPlaced.problems.length === 0 &&
          movedBox !== undefined &&
          grown > 20 &&
          (handle !== null || near(grown, Math.ceil(boxBottom + 24) - boundBefore, 1.5)),
        {
          movedId,
          grown,
          boundBefore,
          boxBottom,
          resized: handle !== null,
          problems: movedPlaced.problems.slice(0, 5),
        },
      );
      await click('#unlock-positions');
      await until(`window.__smoke.attr('data-positions-unlocked') === 'true'`, 'unlocked again');
      await click('#reset-positions');
      await until(`window.__smoke.attr('data-moved-count') === '0'`, 'positions reset');
      await click('#unlock-positions');
      await until(
        `window.__smoke.attr('data-positions-unlocked') === 'false'`,
        'locked at the end',
      );
      await fit();

      // A part of the map: what the window shows, at the scale of the map. The domain furthest
      // to the right is dragged out of the window with the map.
      await choose({ area: 'view', caption: false });
      /** @type {{ id: string, name: string }} */
      const outside = (await exportPage('outermost()')).right;
      for (let turn = 0; turn < 6; turn++) {
        /** @type {number} */
        const toGo = await exportPage(`toLeaveRight(${JSON.stringify(outside.id)})`);
        if (toGo <= 0) break;
        await pan(toGo + 10, 0);
      }
      /** @type {number} */
      const stillToGo = await exportPage(`toLeaveRight(${JSON.stringify(outside.id)})`);
      const partCanvas = await exportPage('canvas()');
      const viewAtPart = await viewNow();
      const part = await savedSvg();
      const partPng = await exported('png');
      const partPngSize = pngSizeOf(partPng.file);
      const partHtml = await exported('html');
      const partPage = await exportPage(
        `page(${JSON.stringify(partHtml.file?.toString('utf8') ?? '')})`,
      );
      const partWidth = (partCanvas.width - partCanvas.covered) / viewAtPart.zoom;
      const partHeight = partCanvas.height / viewAtPart.zoom;
      check(
        'What is on screen: the picture is the part of the map in the window, in pixels of the map; a domain outside it is in none of the files; the PNG is twice the SVG',
        stillToGo <= 0 &&
          Number.isInteger(part.read.width) &&
          Number.isInteger(part.read.height) &&
          // Grown to whole pixels of the map on every side: less than two more.
          part.read.width >= partWidth - 0.001 &&
          part.read.width < partWidth + 2 &&
          part.read.height >= partHeight - 0.001 &&
          part.read.height < partHeight + 2 &&
          part.read.nodes.length > 0 &&
          !part.read.nodes.includes(outside.id) &&
          outside.name !== '' &&
          !part.read.names.includes(outside.name) &&
          partHtml.status.state === 'saved' &&
          partPage.drawn.length === part.read.nodes.length &&
          !partPage.listed.includes(outside.id) &&
          !partPage.names.includes(outside.name) &&
          partPngSize !== null &&
          partPngSize.width === 2 * part.read.width &&
          partPngSize.height === 2 * part.read.height,
        {
          outside,
          stillToGo,
          svg: [part.read.width, part.read.height],
          window: [partWidth, partHeight],
          png: partPngSize,
          boxes: part.read.nodes.length,
        },
      );
      // Dragged on until nothing of the map is in the window: nothing to save.
      for (let turn = 0; turn < 12 && (await exportPage('inView(40)')) > 0; turn++) {
        await pan(0, -2000);
      }
      const nothing = await exported('svg');
      // A file that does not come cannot be awaited: it is looked for a moment later.
      await sleep(500);
      const arrived = await readdir(exportsDir);
      check(
        'What is on screen, with nothing of the map there: the section says so and no file is saved',
        (await exportPage('inView(40)')) === 0 &&
          nothing.status.state === 'failed' &&
          nothing.status.text === 'Nothing of the map is on screen.' &&
          nothing.status.name === undefined &&
          nothing.file === undefined &&
          !arrived.includes('architecture-map.svg'),
        { status: nothing.status, arrived },
      );
      await choose({ area: 'map', caption: true });
      await fit();

      // The two colour schemes. The screen is made dark for a moment, and made light again
      // whatever happens: everything after this expects the light scheme.
      /**
       * Whether the background of an exported SVG is that colour.
       * @param {{ read: any }} picture @param {Colour | undefined} bg
       */
      const hasBackground = (picture, bg) => sameColour(picture.read.background, bg);
      const canvasColours = () =>
        evaluate(`JSON.stringify([
          getComputedStyle(document.querySelector('.react-flow__node-leaf .arch-node')).backgroundColor,
          getComputedStyle(document.querySelector('.react-flow__node-leaf .arch-node-name')).color,
          getComputedStyle(document.documentElement).getPropertyValue('--bg'),
        ])`);
      await choose({ scale: '1' });
      await client.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'dark' }],
      });
      /** @type {Record<string, Colour>} */
      let dark = {};
      try {
        await until(
          `window.matchMedia('(prefers-color-scheme: dark)').matches`,
          'the dark colour scheme',
        );
        dark = await paletteNow();
        const darkCanvas = await canvasColours();
        const asOnScreen = await savedSvg();
        const darkPng = await exported('png');
        /** @type {number[] | undefined} */
        let darkCorner;
        if (darkPng.file !== undefined) {
          await showPicture('dark', darkPng.file.toString('base64'));
          [darkCorner] = await pixelsOf('dark', [[0, 0]]);
          await exportPage('forget()');
        }
        await choose({ scheme: 'light' });
        const lightOnDark = await savedSvg();
        check(
          'on a dark screen "As on screen" gives a dark SVG and a dark PNG, "Light" a light SVG, and the canvas stays as it is',
          !sameColour(dark['--bg'], light['--bg'], 20) &&
            hasBackground(asOnScreen, dark['--bg']) &&
            sameColour(colourOf(darkCorner), dark['--bg'], 3) &&
            hasBackground(lightOnDark, light['--bg']) &&
            (await canvasColours()) === darkCanvas,
          {
            dark: dark['--bg'],
            light: light['--bg'],
            asOnScreen: asOnScreen.read.background,
            darkCorner,
            lightOnDark: lightOnDark.read.background,
          },
        );
      } finally {
        await client.send('Emulation.setEmulatedMedia', { features: [] });
        await until(
          `!window.matchMedia('(prefers-color-scheme: dark)').matches`,
          'the light colour scheme again',
        );
      }
      const lightCanvas = await canvasColours();
      await choose({ scheme: 'dark' });
      const darkOnLight = await savedSvg();
      check(
        'on a light screen "Dark" gives a dark SVG, and the canvas stays light',
        hasBackground(darkOnLight, dark['--bg']) &&
          !hasBackground(darkOnLight, light['--bg']) &&
          (await canvasColours()) === lightCanvas,
        { darkOnLight: darkOnLight.read.background, dark: dark['--bg'] },
      );
      await choose({ scheme: 'screen', scale: '2' });

      // Names, at the two levels that draw every box: whole where the canvas shows them whole.
      for (const [level, name] of /** @type {[string, string][]} */ ([
        ['subcomponents', 'Subcomponents'],
        ['detail', 'Everything'],
      ])) {
        await pinLod(level);
        await fit();
        await savedSvg();
        const named = await nameProblems();
        check(
          `SVG: at the ${name} level a name is whole where the canvas shows it whole, as long and as high up as there, and cut where the canvas cuts it`,
          named.problems.length === 0 && named.whole.length > 20,
          { cut: named.cut, whole: named.whole.length, problems: named.problems.slice(0, 3) },
        );
      }

      // Everything, with the work items: every line, and the mark of the selected one.
      await click('.arch-workitem-item[data-workitem-id="1010"]');
      await untilSelection('workitem:1010');
      await settled();
      await savedSvg();
      const items = await exportPage('workItems()');
      check(
        'work items: every line of the canvas is in the picture, and the lines of the selected work item are marked',
        items.canvas > 20 &&
          items.picture === items.canvas &&
          items.selected.canvas.length > 0 &&
          same(items.selected.picture, items.selected.canvas),
        items,
      );
      await press('Escape', { keyCode: 27 });
      await untilSelection(null);
      await fit();

      // How long the three take for the example at its largest, and how large the files are.
      // The page of this map is the one opened at the end.
      const largest = await savedSvg();
      const largestPng = await exported('png');
      const largestHtml = await exported('html');
      const cost = (/** @type {Exported} */ made) =>
        `${made.status.format ?? '?'} ${made.status.ms ?? '?'} ms, ${made.status.bytes ?? '?'} bytes`;
      check(
        `at the Everything level the three files are made (${[largest, largestPng, largestHtml].map(cost).join('; ')})`,
        largest.status.state === 'saved' &&
          largestPng.status.state === 'saved' &&
          largestHtml.status.state === 'saved' &&
          largestPng.status.reduced === 'false' &&
          [largest, largestPng, largestHtml].every(
            (made) => Number(made.status.ms) >= 0 && Number(made.status.bytes) > 0,
          ),
        [largest.status, largestPng.status, largestHtml.status],
      );
      const pageFile = path.join(exportsDir, 'architecture-map.html');
      const pageBoxes = /** @type {string[]} */ (largest.read.nodes);
      const pageEdges = /** @type {string[]} */ (largest.read.edges);

      // Auto, zoomed out to the Domains level: the larger titles.
      await pinLod('auto', await attr('data-zoom-lod'));
      await zoomToLevel('domains');
      await savedSvg();
      /** @type {{ id: string, size: number, lines: number, picture: number[] | null }[]} */
      const titles = await exportPage('largeTitles()');
      const wrongTitles = titles.filter(
        (title) =>
          title.size !== 28 ||
          title.picture === null ||
          title.picture.length !== title.lines ||
          title.picture.some((size) => size !== 28),
      );
      check(
        'the larger titles of the Domains level: the name of a domain is 28 px in the picture as on the canvas, on as many lines',
        (await attr('data-lod')) === 'domains' &&
          (await attr('data-zoom-lod')) === 'domains' &&
          titles.length > 2 &&
          wrongTitles.length === 0,
        { titles: titles.length, wrong: wrongTitles.slice(0, 5) },
      );

      // The PNG against the screen: the same part of the map, pixel for pixel of the map — at a
      // zoom of exactly 1, which a link carries, with the view at whole pixels.
      await pinLod('detail');
      await fit();
      await evaluate(`document.querySelector('#copy-view-link').click()`);
      await until(`window.location.hash.startsWith('#view=')`, 'the link in the address bar');
      const fittedView = JSON.parse(
        Buffer.from(
          /** @type {string} */ (await evaluate(`window.location.hash`)).slice('#view='.length),
          'base64url',
        ).toString('utf8'),
      );
      const fittedCanvas = await exportPage('canvas()');
      const viewAtOne = {
        ...fittedView,
        center: {
          x: fittedCanvas.width / 2 - Math.round(fittedCanvas.width / 2 - fittedView.center.x),
          y: fittedCanvas.height / 2 - Math.round(fittedCanvas.height / 2 - fittedView.center.y),
          zoom: 1,
        },
      };
      await reloadWith(linkOf(viewAtOne));
      const atOne = await eventually(
        `window.__smoke.attr('data-lod') === 'detail' && window.__smoke.attr('data-lines-laid-out') === 'true' && window.__smoke.viewport()?.zoom === 1`,
        'the view of the link, at a zoom of 1',
      );
      await settled();
      // The fragment would apply the view on every load from here on.
      await evaluate(`window.history.replaceState(null, '', window.location.href.split('#')[0])`);
      await choose({ area: 'view', caption: false, scale: '1' });
      const viewOne = await viewNow();
      const onScreen = await savedSvg();
      const screenPng = await exported('png');
      await park();
      const clip = await exportPage('canvas()');
      /** @type {Probe[]} */
      const screenProbes = (await exportPage('probes()')).filter(
        (/** @type {Probe} */ probe) =>
          probe.clear && ['leaf', 'group', 'gutter'].includes(probe.kind),
      );
      /** @type {string | undefined} */
      let shot;
      await exportPage('hideOverlays()');
      try {
        await evaluate(`window.__smoke.frames()`);
        shot = (
          await client.send('Page.captureScreenshot', {
            format: 'png',
            clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
          })
        ).data;
      } finally {
        await exportPage('showOverlays()');
      }
      let largestDifference = NaN;
      /** @type {string[]} */
      const different = [];
      if (screenPng.file !== undefined && shot !== undefined) {
        await showPicture('png', screenPng.file.toString('base64'));
        await showPicture('screen', shot);
        const [shiftX, shiftY] = /** @type {[number, number]} */ (onScreen.read.shift);
        const inPicture = await pixelsOf(
          'png',
          screenProbes.map((probe) => [Math.floor(probe.x + shiftX), Math.floor(probe.y + shiftY)]),
        );
        const inScreen = await pixelsOf(
          'screen',
          screenProbes.map((probe) => [Math.floor(probe.screen[0]), Math.floor(probe.screen[1])]),
        );
        largestDifference = 0;
        screenProbes.forEach((probe, i) => {
          const difference = Math.max(
            ...[0, 1, 2].map((channel) =>
              Math.abs((inPicture[i]?.[channel] ?? NaN) - (inScreen[i]?.[channel] ?? NaN)),
            ),
          );
          if (!(difference <= 12)) {
            different.push(
              `${probe.kind} ${probe.id}: ${JSON.stringify([inPicture[i], inScreen[i]])}`,
            );
          }
          largestDifference = Math.max(
            largestDifference,
            Number.isNaN(difference) ? 255 : difference,
          );
        });
        await exportPage('forget()');
      }
      check(
        `PNG against the screen: at a zoom of 1 the picture of what is on screen has the colours of the screen (largest difference ${largestDifference} of 255 at ${screenProbes.length} points)`,
        atOne &&
          viewOne.zoom === 1 &&
          Number.isInteger(viewOne.x) &&
          Number.isInteger(viewOne.y) &&
          clip.ratio === 1 &&
          (await selection()) === null &&
          screenPng.status.state === 'saved' &&
          screenPng.status.scale === '1.0000' &&
          Number(screenPng.status.width) === onScreen.read.width &&
          Number(screenPng.status.height) === onScreen.read.height &&
          // Probes under a label or another element on top are left out: this screen keeps six.
          screenProbes.length >= 5 &&
          largestDifference <= 12 &&
          different.length === 0,
        {
          viewOne,
          clip,
          probes: screenProbes.length,
          largestDifference,
          different: different.slice(0, 5),
        },
      );

      // Remembered: the four choices are stored as they are made, and shown again after a
      // reload. A stored entry that is no choice gives the choice nobody has made.
      const errorsBeforeReloads = exportErrors.length;
      await choose({ area: 'view', scheme: 'dark', scale: '3', caption: false });
      /** @type {string | null} */
      const storedChoices = await evaluate(`localStorage.getItem('${EXPORT_KEY}')`);
      await reloadWith('');
      await showControl('#export');
      const choicesKept = await choicesShown();
      check(
        'the four choices are stored in the browser as they are made, and the section shows them again after a reload',
        storedChoices === '{"area":"view","scheme":"dark","caption":false,"scale":3}' &&
          same(choicesKept, { area: 'view', scheme: 'dark', scale: '3', caption: false }),
        { storedChoices, choicesKept },
      );
      await evaluate(
        `localStorage.setItem('${EXPORT_KEY}', '{"area":"x","scale":7,"caption":"no","scheme":"dark"}')`,
      );
      await reloadWith('');
      await showControl('#export');
      const choicesRead = await choicesShown();
      check(
        'a stored entry that is no choice gives the choice nobody has made, the others are kept, and nothing fails in the page',
        same(choicesRead, { area: 'map', scheme: 'dark', scale: '2', caption: true }) &&
          exportErrors.length === errorsBeforeReloads,
        { choicesRead, errors: exportErrors.slice(errorsBeforeReloads, errorsBeforeReloads + 5) },
      );
      await choose({ scheme: 'screen' });

      // A structure of its own: boxes are sized by the number of characters of their names, so
      // names of wide letters do not fit, and the canvas cuts them. Opened as the picker would:
      // a file dropped on the page would join the recent maps.
      await evaluate(
        `window.__smoke.openFile('#yaml-file', 'wide.yaml', ${JSON.stringify(
          [
            'version: 1',
            'domains:',
            '  - id: wide',
            '    name: WWWWWWWWWWWWWWWWWWWW',
            '    components:',
            '      - { id: wide.leaf, name: WWWWWWWWWWWWWWWWWWWW }',
            '  - id: plain',
            '    name: Plain',
            '    components:',
            '      - { id: plain.leaf, name: Short }',
            '',
          ].join('\n'),
        )})`,
      );
      await until(`window.__smoke.text('#source-name') === 'wide.yaml'`, 'the map of wide names');
      await until(
        `window.__smoke.count('.react-flow__node[data-id="wide"]') === 1`,
        'the domain of wide names',
      );
      await pinLod('subcomponents');
      await fit();
      await choose({ caption: false });
      const wide = await savedSvg('wide');
      const wideNames = await nameProblems();
      check(
        'SVG: a name the canvas cuts ends in "…" in the picture and stays within its box, for a leaf and for a group; the short names beside them are whole',
        wide.status.name === 'wide-map.svg' &&
          wideNames.problems.length === 0 &&
          same(wideNames.cut, ['wide', 'wide.leaf']) &&
          same(wideNames.whole, ['plain', 'plain.leaf']),
        { status: wide.status, ...wideNames },
      );

      // The exported page, opened: this leaves the viewer, so it comes last. It is the page of
      // the example at the Everything level.
      const pageRequests = requests.length;
      const pageViolations = violations.length;
      await client.send('Page.navigate', { url: pathToFileURL(pageFile).href });
      await until(
        `document.readyState === 'complete' && document.querySelector('.map svg') !== null`,
        'the exported page',
      );
      exportedPage = await evaluate(`window.location.href`);
      const pageState = () =>
        evaluate(`(() => {
          const svg = document.querySelector('.map svg');
          const region = document.querySelector('.map');
          return {
            fit: document.querySelector('#fit').checked,
            width: svg.getBoundingClientRect().width,
            own: Number(svg.getAttribute('width')),
            room: region.clientWidth,
            scroll: region.scrollWidth,
          };
        })()`);
      const opened = await evaluate(`({
        policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
        scripts: document.scripts.length,
        listed: document.querySelectorAll('li[data-node]').length,
        rows: document.querySelectorAll('tr[data-edge]').length,
        drawn: [...document.querySelectorAll('.map svg g[data-node]')].map((g) => g.getAttribute('data-node')),
        title: document.title,
      })`);
      const fitted = await pageState();
      const pageAsked = requests.slice(pageRequests);
      check(
        'HTML: opened, the page keeps its policy, runs no script, asks for nothing but itself, and lists every box and edge of its picture',
        exportedPage?.toLowerCase() === pathToFileURL(pageFile).href.toLowerCase() &&
          opened.policy === EXPORT_PAGE_POLICY &&
          opened.scripts === 0 &&
          opened.title === 'architecture.yaml' &&
          pageAsked.includes(exportedPage ?? '') &&
          pageAsked.every((url) => url === exportedPage || url.startsWith('data:')) &&
          violations.length === pageViolations &&
          pageBoxes.length > 20 &&
          same(opened.drawn, pageBoxes) &&
          opened.listed === pageBoxes.length &&
          opened.rows === pageEdges.length,
        {
          exportedPage,
          policy: opened.policy,
          scripts: opened.scripts,
          asked: pageAsked.slice(0, 5).map((url) => url.slice(0, 200)),
          violations: violations.slice(pageViolations, pageViolations + 5),
          listed: opened.listed,
          rows: opened.rows,
          boxes: pageBoxes.length,
          edges: pageEdges.length,
        },
      );
      await clickAt(
        await evaluate(`(() => {
          const r = document.querySelector('#fit').getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`),
        '#fit',
      );
      const unfitted = await eventually(
        `!document.querySelector('#fit').checked`,
        'Fit the width switched off',
      );
      const ownSize = await pageState();
      check(
        'HTML: Fit the width is on at first and the picture is as wide as its region; switched off, the picture has its own width and the region scrolls',
        fitted.fit === true &&
          near(fitted.width, fitted.room, 1) &&
          unfitted &&
          near(ownSize.width, ownSize.own, 1) &&
          ownSize.own > ownSize.room &&
          ownSize.scroll > ownSize.room,
        { fitted, ownSize },
      );
      const linked = pageBoxes.find((id) => !id.includes('.')) ?? '';
      await evaluate(`window.location.hash = ${JSON.stringify(`#n.${linked}`)}`);
      const targeted = await eventually(
        `document.getElementById(${JSON.stringify(`n.${linked}`)})?.matches(':target') === true`,
        'the box the link names',
      );
      const outline = await evaluate(`(() => {
        const style = getComputedStyle(document.getElementById(${JSON.stringify(`n.${linked}`)}).querySelector('rect[data-part="box"]'));
        return { stroke: style.stroke, width: style.strokeWidth };
      })()`);
      const [red, green, blue] = (String(outline.stroke).match(/[\d.]+/g) ?? []).map(Number);
      check(
        'HTML: a link of the list marks its box in the picture, with the outline of a selected box',
        linked !== '' &&
          targeted &&
          outline.width === '4px' &&
          sameColour(
            colourOf([red ?? NaN, green ?? NaN, blue ?? NaN, 255]),
            light['--node-selected'],
          ),
        { linked, outline, selected: light['--node-selected'] },
      );

      // Back in the viewer, which starts without a map — and so without the section.
      await client.send('Page.navigate', { url: pathToFileURL(viewerPath).href });
      await startPage();
      check(
        'the start page, without a map, has no Export section',
        (await evaluate(`document.querySelectorAll('#export').length`)) === 0 &&
          (await evaluate(`document.querySelectorAll('#yaml-file').length`)) === 1,
      );
      await dropFiles(dataFiles);
      await mapShown();
      await until(`window.__smoke.attr('data-lines-laid-out') === 'true'`, 'the example again');

      // Back to what the block started from.
      await client
        .send('Browser.setDownloadBehavior', { behavior: 'default' })
        .catch(() => undefined);
      if ((await attr('data-color-by')) !== exportStart.colorBy) {
        await chooseOption('#color-by', exportStart.colorBy ?? 'none');
      }
      if ((await attr('data-story-mode')) !== exportStart.storyMode) {
        await chooseStories(exportStart.storyMode ?? 'stories');
      }
      await setSetting('heat', exportStart.heat === 'true');
      await setSetting('progress', exportStart.progress === 'true');
      await setSetting('edges-on-demand', exportStart.onDemand === 'true');
      await setSetting('compact-collapsed', exportStart.shrink === 'true');
      if ((await attr('data-focus-mode')) !== exportStart.focusMode) await click('#focus-mode');
      await showRows(exportStart.rows === 'true');
      await closeUp(exportStart.closeGaps === 'true');
      await evaluate(
        `document.querySelector('#views-list li[data-view-name="${EXPORT_START_VIEW}"] .views-apply').click()`,
      );
      await until(
        `window.__smoke.attr('data-lod-mode') === ${JSON.stringify(exportStart.lodMode)} && window.__smoke.attr('data-collapsed-count') === ${JSON.stringify(exportStart.collapsed)} && window.__smoke.attr('data-hidden-kinds') === ${JSON.stringify(exportStart.hiddenKinds)} && window.__smoke.attr('data-lines-laid-out') === 'true'`,
        'the view the exports started from',
      );
      await settled();
      await evaluate(
        `document.querySelector('#views-list li[data-view-name="${EXPORT_START_VIEW}"] .views-delete').click()`,
      );
      await until(
        `window.__smoke.count('#views-list li[data-view-name="${EXPORT_START_VIEW}"]') === 0`,
        'the view to come back to deleted',
      );
      if ((await attr('data-panel-tab')) !== exportStart.tab) {
        await click(`#tab-${exportStart.tab}`);
        await until(
          `window.__smoke.attr('data-panel-tab') === '${exportStart.tab}'`,
          'the tab shown before the exports',
        );
      }
      if ((await attr('data-panel-collapsed')) !== exportStart.panelCollapsed) {
        await togglePanel(exportStart.panelCollapsed === 'true');
      }
      // What the block left in the storage of the browser: the choices, and what the viewer
      // keeps for the structure of wide names.
      await evaluate(`(() => {
        const kept = ${JSON.stringify(exportStart.keys)};
        for (const key of Object.keys(localStorage)) {
          if (!kept.includes(key)) localStorage.removeItem(key);
        }
        const stored = ${JSON.stringify(exportStart.stored)};
        if (stored !== null) localStorage.setItem(${JSON.stringify(EXPORT_KEY)}, stored);
      })()`);

      // Nothing of all this needed more than the policy of the viewer allows: no violation, and
      // no request but for the files of the viewer, the pictures (`data:`), the downloads
      // (`blob:`) and the exported page.
      const viewerFolder = `${pathToFileURL(path.dirname(viewerPath)).href}/`.toLowerCase();
      const askedElsewhere = requests
        .slice(exportStart.requests)
        .filter(
          (url) =>
            !url.toLowerCase().startsWith(viewerFolder) &&
            !url.startsWith('data:') &&
            !url.startsWith('blob:') &&
            url !== exportedPage,
        );
      check(
        'nothing of the exports violated the policy of the viewer, left its folder or failed in the page',
        violations.length === exportStart.violations &&
          askedElsewhere.length === 0 &&
          exportErrors.length === 0,
        {
          violations: violations.slice(exportStart.violations, exportStart.violations + 5),
          asked: askedElsewhere.slice(0, 5).map((url) => url.slice(0, 200)),
          errors: exportErrors.slice(0, 5),
        },
      );
    }

    // --- Edge-kind filter ---------------------------------------------------------------------
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await click('#expand-all');
    await until(`window.__smoke.attr('data-collapsed-count') === '0'`, 'everything expanded');
    await sleep(400); // newly shown nodes are measured before their edges are drawn
    const dataflowBefore = await evaluate(
      `window.__smoke.count('.react-flow__edge.arch-edge-dataflow')`,
    );
    const edgesBefore = await evaluate(`window.__smoke.count('.react-flow__edge')`);
    await click('#kind-filters [data-kind="dataflow"]');
    await until(`window.__smoke.attr('data-hidden-kinds') === 'dataflow'`, 'the filter');
    await sleep(200);
    check(
      'a hidden kind disappears from the canvas',
      dataflowBefore > 0 &&
        (await evaluate(`window.__smoke.count('.react-flow__edge.arch-edge-dataflow')`)) === 0 &&
        (await evaluate(`window.__smoke.count('.react-flow__edge')`)) ===
          edgesBefore - dataflowBefore,
    );
    check(
      'the toggle reports its state',
      (await evaluate(
        `document.querySelector('#kind-filters [data-kind="dataflow"]').getAttribute('aria-pressed')`,
      )) === 'false',
    );

    // --- Persistence across a reload ----------------------------------------------------------
    await click('#fit-view');
    await sleep(600);
    await click('.react-flow__node[data-id="platform"] .arch-chevron');
    await until(`window.__smoke.attr('data-collapsed-count') === '1'`, 'one collapsed group');
    await sleep(600); // let the viewport settle and be stored
    const before = await evaluate(`window.__smoke.viewport()`);
    await open();
    const after = await evaluate(`window.__smoke.viewport()`);
    check(
      'reload restores the viewport instead of fitting',
      Math.abs(after.x - before.x) < 1 &&
        Math.abs(after.y - before.y) < 1 &&
        Math.abs(after.zoom - before.zoom) < 0.001,
      { before, after },
    );
    check(
      'reload restores the edge-kind filter',
      (await evaluate(`window.__smoke.attr('data-hidden-kinds')`)) === 'dataflow',
    );
    check(
      'reload restores the collapsed groups',
      (await evaluate(`window.__smoke.attr('data-collapsed-count')`)) === '1',
    );
    await click('#kind-filters [data-kind="dataflow"]');
    await until(`window.__smoke.attr('data-hidden-kinds') === ''`, 'the filter off');
    check(
      'showing the kind again restores its edges',
      (await evaluate(`window.__smoke.count('.react-flow__edge.arch-edge-dataflow')`)) > 0,
    );

    // The view kept across a change of the story mode is the stored one: a reload comes back
    // to the same place, not to where the view was in the layout before.
    await openSearch();
    await client.send('Input.insertText', { text: 'data.event-store' });
    await until(`window.__smoke.count('#search-results [role="option"]') > 0`, 'search results');
    await press('Enter', { keyCode: 13, text: '\r' });
    await untilSelection('node:data.event-store');
    await settled();
    await sleep(600);
    const eventStore = '.react-flow__node[data-id="data.event-store"]';
    const centredBefore = await evaluate(
      `window.__smoke.centreOffset(${JSON.stringify(eventStore)})`,
    );
    await chooseStories('off');
    await settled();
    await sleep(800);
    const centredOff = await evaluate(`window.__smoke.centreOffset(${JSON.stringify(eventStore)})`);
    const viewOff = await evaluate(`window.__smoke.viewport()`);
    await open();
    // Compared as viewports: after the reload nothing is selected, so the canvas is wider by
    // the detail panel and its middle is elsewhere.
    const viewReloaded = await evaluate(`window.__smoke.viewport()`);
    check(
      'the place kept across a story-mode change is still there after a reload',
      centredBefore !== null &&
        centredOff !== null &&
        Math.abs(centredOff.dx - centredBefore.dx) <= 2 &&
        Math.abs(centredOff.dy - centredBefore.dy) <= 2 &&
        Math.abs(viewReloaded.x - viewOff.x) < 1 &&
        Math.abs(viewReloaded.y - viewOff.y) < 1 &&
        Math.abs(viewReloaded.zoom - viewOff.zoom) < 0.001 &&
        (await evaluate(`window.__smoke.attr('data-story-mode')`)) === 'off',
      { centredBefore, centredOff, viewOff, viewReloaded },
    );
    await chooseStories('stories');

    // A stored viewport that would leave the canvas empty (the map pushed out at the bottom
    // right of the window) is not restored: the view is fitted instead.
    const moved = await evaluate(`(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith('architecture-map.viewport:'));
      if (!key) return false;
      localStorage.setItem(key, JSON.stringify({ x: innerWidth - 2, y: innerHeight - 2, zoom: 1 }));
      return true;
    })()`);
    await open();
    await sleep(400);
    const fitted = await evaluate(`window.__smoke.viewport()`);
    const nodesShown = await evaluate(`window.__smoke.nodesOnCanvas()`);
    check(
      'a stored viewport that shows nothing of the map is replaced by a fit',
      moved && nodesShown > 0,
      { fitted, nodesShown },
    );

    // --- Diagnostics of other work-item files -------------------------------------------------
    const openFile = (
      /** @type {string} */ input,
      /** @type {string} */ name,
      /** @type {string} */ content,
    ) =>
      evaluate(
        `window.__smoke.openFile(${JSON.stringify(input)}, ${JSON.stringify(name)}, ${JSON.stringify(content)})`,
      );
    const diagnosticsState = () =>
      evaluate(`(() => {
        const panel = document.querySelector('#diagnostics');
        if (!panel) return null;
        if (panel.dataset.open !== 'true') panel.querySelector('.diagnostics-toggle').click();
        return new Promise((resolve) => setTimeout(() => resolve({
          errors: Number(panel.dataset.errors),
          warnings: Number(panel.dataset.warnings),
          heading: document.querySelector('#diagnostics-workitems h3')?.textContent ?? null,
          coverage: document.querySelector('#tag-coverage')?.dataset.percent ?? null,
          rows: document.querySelectorAll('#diagnostics-workitems .diagnostic').length,
          messages: [...document.querySelectorAll('#diagnostics .diagnostic-message')].map((e) => e.textContent),
        }), 100));
      })()`);
    // Every item tagged, nothing to report: the heading and the coverage are shown all the same.
    await openFile(
      '#workitems-file',
      'tagged.json',
      JSON.stringify({
        version: 1,
        items: [
          { id: 1, type: 'User Story', title: 'One', state: 'Active', tags: 'comp:storefront.web' },
          { id: 2, type: 'Task', title: 'Two', state: 'active', parentId: 1 },
          { id: 3, type: 'Task', title: 'Three', state: 'New', parentId: 2 },
        ],
      }),
    );
    await until(`window.__smoke.text('#workitems-source') === 'tagged.json'`, 'the tagged file');
    await until(`window.__smoke.attr('data-workitems') === '3'`, 'three work items');
    const tagged = await diagnosticsState();
    check(
      'a fully tagged work-items file still shows its heading and the tag coverage',
      tagged !== null &&
        tagged.errors === 0 &&
        tagged.warnings === 0 &&
        tagged.heading.includes('tagged.json') &&
        tagged.coverage === '100' &&
        tagged.rows === 0,
      tagged,
    );
    const stateBoxes = await evaluate(
      `[...document.querySelectorAll('[data-workitem-state]')].map((e) => e.dataset.workitemState)`,
    );
    check(
      'states that differ only in letter case are one filter choice',
      stateBoxes.length === 2 && stateBoxes.includes('New') && stateBoxes.includes('Active'),
      stateBoxes,
    );
    // A file that is not JSON: its error, and no coverage of nothing.
    await openFile('#workitems-file', 'broken.json', '{"version":1,"items":[');
    await until(`window.__smoke.text('#workitems-source') === 'broken.json'`, 'the broken file');
    await until(`window.__smoke.count('#diagnostics[data-errors="1"]') === 1`, 'its error');
    const broken = await diagnosticsState();
    check(
      'a broken work-items file shows its error and no tag coverage',
      broken !== null &&
        broken.heading.includes('broken.json') &&
        broken.coverage === null &&
        broken.rows === 1 &&
        broken.messages.some((/** @type {string} */ m) => m.includes('Not valid JSON')),
      broken,
    );
    // A structure with errors does not hide the problems of the work-items file.
    await openFile('#yaml-file', 'bad.yaml', 'version: 1\ndomains: 5\n');
    await until(`window.__smoke.text('#source-name') === 'bad.yaml'`, 'the bad structure');
    await until(`window.__smoke.count('.react-flow__node') === 0`, 'no map');
    const both = await diagnosticsState();
    check(
      'with errors in the structure file the problems of the work-items file are still listed',
      both !== null &&
        both.errors >= 2 &&
        both.heading !== null &&
        both.heading.includes('broken.json') &&
        both.coverage === null &&
        both.messages.some((/** @type {string} */ m) => m.includes('Not valid JSON')),
      both,
    );

    // --- Recent maps: a second map, read again from the disk, and forgotten -------------------
    scratch ??= await mkdtemp(path.join(os.tmpdir(), 'arch-map-smoke-data-'));
    const small = path.join(scratch, 'small.yaml');
    const yamlOf = (/** @type {string[]} */ names) =>
      `version: 1\ndomains:\n${names.map((name) => `  - id: ${name.toLowerCase()}\n    name: ${name}\n`).join('')}`;
    await writeFile(small, yamlOf(['Alpha']));
    await dropFiles([small]);
    await until(`window.__smoke.text('#source-name') === 'small.yaml'`, 'the small map');
    await until(`window.__smoke.count('.react-flow__node[data-id="alpha"]') === 1`, 'its domain');
    const twoRecent = await recentState();
    check(
      'another map opened from disk comes first in the recent maps, named by its file and domains',
      twoRecent.entries.length === 2 &&
        twoRecent.entries[0].label === 'small.yaml' &&
        twoRecent.entries[0].current &&
        twoRecent.entries[0].hint.startsWith('Alpha') &&
        twoRecent.entries[1].label === 'architecture.yaml + workitems.json' &&
        !twoRecent.entries[1].current,
      twoRecent,
    );
    await writeFile(small, yamlOf(['Alpha', 'Beta']));
    await click('#reload-files');
    await until(
      `window.__smoke.count('.react-flow__node[data-id="beta"]') === 1`,
      'the file read again',
    );
    const reloaded = await recentState();
    check(
      'Reload reads the file again from the disk, and the hint follows',
      (await countOf('.react-flow__node[data-id="alpha"]')) === 1 &&
        reloaded.entries.length === 2 &&
        reloaded.entries[0].hint.startsWith('Alpha, Beta'),
      reloaded,
    );
    await showControl('#recent-list');
    check(
      'the recent maps are listed on the Files tab',
      (await evaluate(`(() => {
        const list = document.querySelector('#recent-list').getBoundingClientRect();
        const panel = document.querySelector('#control-panel').getBoundingClientRect();
        return (
          window.__smoke.attr('data-panel-tab') === 'files' &&
          list.width > 0 &&
          list.left >= panel.left &&
          list.right <= panel.right &&
          // The body of the tab scrolls: the list is in the part shown, not always whole.
          list.bottom > panel.top &&
          list.top < panel.bottom &&
          // Names, hints and the dates after them are there in full, on as many lines as needed.
          [...document.querySelectorAll('#recent-list .recent-name, #recent-list .recent-hint')].every(
            (line) => line.scrollWidth <= line.clientWidth + 1 && line.getBoundingClientRect().right <= list.right + 1,
          )
        );
      })()`)) === true,
    );
    await click('#recent-list li[data-recent="small.yaml"] .recent-forget');
    await until(`window.__smoke.count('#recent-list li') === 1`, 'the map forgotten');
    const forgotten = await recentState();
    check(
      'a recent map can be forgotten; the map stays open, without Reload',
      forgotten.entries[0].label === 'architecture.yaml + workitems.json' &&
        forgotten.reload === 0 &&
        (await countOf('.react-flow__node[data-id="beta"]')) === 1,
      forgotten,
    );

    // --- Focus / Filter: a flow that leaves nothing out ---------------------------------------
    // Such a flow is shown on the whole map, in Filter mode too, and brought on screen there as
    // in Focus mode: at once when the whole map is on screen, and once it is back when the map
    // on screen is filtered to another flow.
    await openFile(
      '#yaml-file',
      'flows.yaml',
      [
        'version: 1',
        'domains:',
        '  - id: a',
        '    name: Alpha',
        '    components:',
        '      - { id: a.x, name: X }',
        '      - { id: a.y, name: Y }',
        '  - id: b',
        '    name: Beta',
        '    components:',
        '      - { id: b.p, name: P }',
        'edges:',
        '  - { id: x-y, from: a.x, to: a.y, kind: dataflow }',
        '  - { id: y-p, from: a.y, to: b.p, kind: dataflow }',
        'flows:',
        '  - { id: all, name: All, edges: [x-y, y-p] }',
        '  - { id: part, name: Part, edges: [x-y] }',
        '',
      ].join('\n'),
    );
    await until(`window.__smoke.text('#source-name') === 'flows.yaml'`, 'the map with two flows');
    await until(`window.__smoke.count('.react-flow__node[data-id="a"]') === 1`, 'its domains');
    await pinLod('subcomponents');
    if ((await attr('data-focus-mode')) !== 'filter') await click('#focus-mode');
    await until(`window.__smoke.attr('data-focus-mode') === 'filter'`, 'Filter mode for the flows');
    /**
     * Fits the map and pans it down until the lower half of its first domain is below the
     * canvas: enough of the map stays in view for a canvas to start from that view, whatever
     * the detail panel takes of its width. Returns the nodes then not entirely on the canvas.
     */
    const panAway = async () => {
      await click('#fit-view');
      await settled();
      const hold = await evaluate(`window.__smoke.emptyPoint()`);
      /** @type {number} */
      const down = await evaluate(`(() => {
        const canvas = document.querySelector('.react-flow').getBoundingClientRect();
        const domain = document.querySelector('.react-flow__node[data-id="a"]').getBoundingClientRect();
        return canvas.bottom - domain.top - domain.height / 2;
      })()`);
      await drag(hold, { x: hold.x, y: hold.y + down });
      await settled();
      return evaluate(`window.__smoke.offCanvas()`);
    };
    /**
     * Whether every node drawn comes to lie on the canvas: the move that brings it there may be
     * yet to start.
     */
    const allOnCanvas = () =>
      until(`window.__smoke.offCanvas().length === 0`, 'every node on the canvas').then(
        () => true,
        () => false,
      );
    const offWhole = await panAway();
    await chooseOption('#focus-select', 'flow:all');
    await until(
      `window.__smoke.attr('data-focus') === 'flow:all'`,
      'the focus that leaves nothing out',
    );
    const shownAtOnce = await allOnCanvas();
    await settled();
    check(
      'in Filter mode a flow that leaves nothing out is brought on screen on the whole map',
      offWhole.length > 0 &&
        shownAtOnce &&
        (await attr('data-filtered')) === null &&
        (await attr('data-drawn-nodes')) === '5' &&
        (await text('#focus-bar')).includes('nothing to leave out'),
      { offWhole, shownAtOnce, bar: await text('#focus-bar') },
    );
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    const offBeforePart = await panAway();
    await chooseOption('#focus-select', 'flow:part');
    await untilFiltered('flow:part');
    const partNodes = await attr('data-drawn-nodes');
    await chooseOption('#focus-select', 'flow:all');
    await untilFiltered(null);
    const shownOnceBack = await allOnCanvas();
    await settled();
    check(
      'a flow that leaves nothing out, chosen on a map filtered to another flow, is brought on screen once the whole map is back',
      offBeforePart.length > 0 &&
        partNodes === '3' &&
        shownOnceBack &&
        (await attr('data-drawn-nodes')) === '5' &&
        (await selection()) === 'flow:all',
      { offBeforePart, partNodes, shownOnceBack, view: await viewNow() },
    );

    // --- Labels and presets in other files: a long legend, a slip in a colour, the template ----
    // The files are dropped on the page; the example and its work items are dropped again at
    // the end.
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    const filesStart = {
      tab: await attr('data-panel-tab'),
      panelCollapsed: await attr('data-panel-collapsed'),
    };
    scratch ??= await mkdtemp(path.join(os.tmpdir(), 'arch-map-smoke-data-'));
    /**
     * Whether the map of a structure file comes to be drawn: its name at the head of the page,
     * its number of nodes on the Files tab. False when it does not in time.
     * @param {string} name @param {number} nodes
     */
    const mapComes = async (name, nodes) => {
      const drawn = await eventually(
        `window.__smoke.text('#source-name') === ${JSON.stringify(name)} && document.querySelector('#model-summary')?.dataset.nodes === '${nodes}' && window.__smoke.count('.react-flow__node') > 0 && window.__smoke.attr('data-lines-laid-out') === 'true'`,
        `the map of ${name}`,
      );
      if (drawn) await settled();
      return drawn;
    };
    /**
     * What is wrong with the place of the colour legend in a window of 1024 × 768 (nothing
     * should be), with the body of the control panel open — it lies over the left of the canvas
     * there, and the legends begin beside it — and collapsed. The window and the body are put
     * back.
     * @param {string} map
     */
    const legendRoom = async (map) => {
      const before = {
        panelCollapsed: await attr('data-panel-collapsed'),
        window: await evaluate(`({ width: window.innerWidth, height: window.innerHeight })`),
      };
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 1024,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await until(`window.innerWidth === 1024 && window.innerHeight === 768`, 'the small window');
      /** @type {string[]} */
      const problems = [];
      for (const collapsed of [false, true]) {
        if ((await attr('data-panel-collapsed')) !== String(collapsed)) {
          await togglePanel(collapsed);
        }
        await settled();
        await evaluate(`window.__smoke.frames()`);
        const room = await evaluate(`(() => {
          const box = (selector) => {
            const el = document.querySelector(selector);
            if (!el || el.getClientRects().length === 0) return null;
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          };
          return {
            legend: box('#color-legend'),
            row: box('.map-row'),
            controls: box('.react-flow__controls'),
            minimap: box('.arch-minimap'),
            body: box('#control-panel-body'),
            page: document.documentElement.scrollWidth,
            window: window.innerWidth,
          };
        })()`);
        const where = `${map}, the panel ${collapsed ? 'collapsed' : 'open'}`;
        const { legend, row, controls, minimap, body } = room;
        if (!legend || !row || !controls || !minimap || (!collapsed && !body)) {
          problems.push(`${where}: not on the page — ${JSON.stringify(room)}`);
          continue;
        }
        if (
          legend.left < row.left - 0.5 ||
          legend.right > row.right + 0.5 ||
          legend.top < row.top - 0.5 ||
          legend.bottom > row.bottom + 0.5
        ) {
          problems.push(`${where}: the legend leaves the map — ${JSON.stringify({ legend, row })}`);
        }
        if (legend.bottom > controls.top) {
          problems.push(
            `${where}: the legend ends at ${Math.round(legend.bottom)}, below the top of the zoom buttons at ${Math.round(controls.top)}`,
          );
        }
        if (
          legend.left < minimap.right &&
          legend.right > minimap.left &&
          legend.top < minimap.bottom &&
          legend.bottom > minimap.top
        ) {
          problems.push(`${where}: the legend lies over the minimap`);
        }
        if (!collapsed && legend.left < body.right - 0.5) {
          problems.push(
            `${where}: the legend begins at ${Math.round(legend.left)}, under the body of the control panel, which ends at ${Math.round(body.right)}`,
          );
        }
        if (room.page > room.window) {
          problems.push(`${where}: the page is ${room.page} wide in a window of ${room.window}`);
        }
      }
      await client.send('Emulation.clearDeviceMetricsOverride');
      await until(
        `window.innerWidth === ${before.window.width} && window.innerHeight === ${before.window.height}`,
        'the window as it was',
      );
      if ((await attr('data-panel-collapsed')) !== before.panelCollapsed) {
        await togglePanel(before.panelCollapsed === 'true');
      }
      await settled();
      return problems;
    };

    // Thirty boxes with thirty values of one label, and a preset that gives each a colour, in
    // the opposite order: the legend of the preset has them all and scrolls; the legend of the
    // label has the eight of the palette, and "Other" for the rest.
    const batches = Array.from(
      { length: 30 },
      (_, index) => `v${String(index + 1).padStart(2, '0')}`,
    );
    const manyFile = path.join(scratch, 'many.yaml');
    await writeFile(
      manyFile,
      [
        'version: 1',
        'domains:',
        ...[0, 1, 2, 3, 4].flatMap((domain) => [
          `  - id: d${domain + 1}`,
          `    name: Domain ${domain + 1}`,
          `    labels: { batch: ${batches[domain * 6]} }`,
          '    components:',
          ...[1, 2, 3, 4, 5].map(
            (part) =>
              `      - { id: d${domain + 1}.c${part}, name: Part ${domain + 1}.${part}, labels: { batch: ${batches[domain * 6 + part]} } }`,
          ),
        ]),
        'presets:',
        '  - name: Batches',
        '    label: batch',
        '    values:',
        ...batches
          .map((value, index) => `      ${value}: '#${(0x203040 + index * 0x070503).toString(16)}'`)
          .reverse(),
        '',
      ].join('\n'),
    );
    await dropFiles([manyFile]);
    const manyDrawn = await mapComes('many.yaml', 30);
    const batchesChosen = await colourBy('preset:Batches');
    const longLegend = await colourLegend();
    const longSize = await evaluate(`(() => {
      const legend = document.querySelector('#color-legend');
      const list = legend?.querySelector('.color-legend-list');
      return list ? { scroll: list.scrollHeight, client: list.clientHeight, height: legend.getBoundingClientRect().height } : null;
    })()`);
    const roomProblems = await legendRoom('thirty values');
    const batchChosen = await colourBy('label:batch');
    const foldedLegend = await colourLegend();
    check(
      'a long legend scrolls, and "Other" names what it stands for',
      manyDrawn &&
        batchesChosen &&
        longLegend !== null &&
        same(longLegend.values, [...batches].reverse()) &&
        longLegend.none.length === 0 &&
        longSize !== null &&
        longSize.scroll > longSize.client &&
        longSize.height <= 300 &&
        batchChosen &&
        foldedLegend !== null &&
        same(foldedLegend.values, [...batches.slice(0, 8), 'Other']) &&
        same(foldedLegend.kinds, [...batches.slice(0, 8).map(() => 'value'), 'other']) &&
        foldedLegend.counts.at(-1) === 22 &&
        boxesOf(foldedLegend.counts) === 30 &&
        foldedLegend.none.length === 0 &&
        // Twenty of the twenty-two values behind "Other" are named.
        foldedLegend.lastTitle === `${batches.slice(8, 28).join(', ')} … and 2 more`,
      { manyDrawn, long: longLegend?.values.length, longSize, foldedLegend },
    );

    // A colour that is none and a hex colour without its quotes: two warnings, and the map.
    const slipFile = path.join(scratch, 'slip.yaml');
    await writeFile(
      slipFile,
      [
        'version: 1',
        'domains:',
        '  - { id: one, name: One, status: live }',
        '  - { id: two, name: Two, status: old }',
        'presets:',
        '  - name: Life',
        '    label: status',
        '    values:',
        '      live: gren',
        '      old: #1baf7a',
        '',
      ].join('\n'),
    );
    await dropFiles([slipFile]);
    const slipDrawn = await mapComes('slip.yaml', 2);
    const slip = await diagnosticsState();
    const slipChosen = await colourBy('preset:Life');
    const slipLegend = await colourLegend();
    const slipWarnings = [
      `Unknown colour "gren" for value "live" of preset "Life"; did you mean "green"? Use blue, orange, teal, yellow, pink, green, purple, red, grey, or a hex colour in quotes such as '#1baf7a'. The next free colour is used`,
      `Value "old" of preset "Life" has no colour: YAML reads the unquoted #1baf7a as a comment; write '#1baf7a' in quotes. The next free colour is used`,
    ];
    check(
      'a mistake in a colour does not stop the map',
      slipDrawn &&
        (await countOf('.react-flow__node[data-id="one"]')) === 1 &&
        slip !== null &&
        slipWarnings.every(
          (warning) =>
            slip.messages.filter((/** @type {string} */ message) => message === warning).length ===
            1,
        ) &&
        slipChosen &&
        slipLegend !== null &&
        same(slipLegend.values, ['live', 'old']),
      { slipDrawn, slip, slipLegend },
    );

    // The template: the build puts its two files beside the viewer as they are in the
    // repository, and they open without a complaint.
    const templateNames = ['architecture.yaml', 'workitems.json'];
    const templateFiles = templateNames.map((name) =>
      path.join(path.dirname(viewerPath), 'template', name),
    );
    const templateSame = await Promise.all(
      templateNames.map(async (name, index) => {
        const built = await readFile(templateFiles[index] ?? name).catch(() => undefined);
        const source = await readFile(
          new URL(`../examples/template/${name}`, import.meta.url),
        ).catch(() => undefined);
        return built !== undefined && source !== undefined && built.equals(source);
      }),
    );
    check('the build delivers the template', same(templateSame, [true, true]), templateSame);
    // The wait is for the nodes of the template: its structure file has the name of the example.
    const templateThere = templateFiles.every((file) => existsSync(file));
    if (templateThere) await dropFiles(templateFiles);
    const templateDrawn =
      templateThere &&
      (await mapComes('architecture.yaml', 9)) &&
      (await eventually(
        `document.querySelector('#workitems-summary')?.dataset.items === '5'`,
        'the work items of the template',
      ));
    const template = await evaluate(`(() => {
      const data = (selector) => ({ ...document.querySelector(selector)?.dataset });
      return {
        source: window.__smoke.text('#source-name'),
        structure: data('#model-summary'),
        items: data('#workitems-summary').items ?? null,
        diagnostics: data('#diagnostics'),
        offered: [...document.querySelectorAll('#color-by option')].map((option) => option.value),
      };
    })()`);
    const zonesChosen = templateDrawn && (await colourBy('preset:Zones'));
    const zones = await colourLegend();
    check(
      'the template opens clean',
      templateDrawn &&
        template.source === 'architecture.yaml' &&
        template.structure.nodes === '9' &&
        template.structure.edges === '4' &&
        template.structure.rows === '2' &&
        template.items === '5' &&
        template.diagnostics.errors === '0' &&
        template.diagnostics.warnings === '0' &&
        template.diagnostics.hints === '1' &&
        template.offered.includes('preset:Zones') &&
        zonesChosen &&
        zones !== null &&
        zones.title === 'Zones' &&
        same(zones.values, ['public', 'payment', 'internal']),
      { templateThere, template, zones },
    );

    // The example again, and the room of its legend under the preset with a subtitle.
    await dropFiles(dataFiles);
    if (!(await mapComes('architecture.yaml', 45))) {
      throw new Error('the example did not come back');
    }
    const exposureInSmall = await colourBy('preset:Exposure');
    roomProblems.push(...(await legendRoom('the example')));
    check(
      'the legend has room in a small window',
      manyDrawn && batchesChosen && exposureInSmall && roomProblems.length === 0,
      roomProblems,
    );
    await colourBy('none');
    // The maps of these checks are forgotten. The template has the file names of the example:
    // its entry is the one whose hint begins with its first domain.
    for (const [recent, domain] of [
      ['many.yaml', 'Domain 1'],
      ['slip.yaml', 'One'],
      ['architecture.yaml + workitems.json', 'Web Shop'],
    ]) {
      /** @type {number} */
      const place = await evaluate(
        `[...document.querySelectorAll('#recent-list li')].findIndex((li) => li.dataset.recent === ${JSON.stringify(recent)} && (li.querySelector('.recent-hint')?.textContent ?? '').startsWith(${JSON.stringify(domain)})) + 1`,
      );
      if (place === 0) continue;
      const entries = await countOf('#recent-list li');
      await click(`#recent-list li:nth-child(${place}) .recent-forget`);
      await until(
        `window.__smoke.count('#recent-list li') === ${entries - 1}`,
        `the map ${recent} forgotten`,
      );
    }
    if ((await attr('data-panel-tab')) !== filesStart.tab) {
      await click(`#tab-${filesStart.tab}`);
      await until(
        `window.__smoke.attr('data-panel-tab') === '${filesStart.tab}'`,
        'the tab shown before the files',
      );
    }
    if ((await attr('data-panel-collapsed')) !== filesStart.panelCollapsed) {
      await togglePanel(filesStart.panelCollapsed === 'true');
    }

    // --- Offline: nothing left the folder, and the policy would not have let it ---------------
    const policy = await evaluate(
      `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null`,
    );
    check(
      'the page declares a Content Security Policy: all forbidden, only its own code by hash',
      typeof policy === 'string' &&
        policy.startsWith("default-src 'none'") &&
        /script-src [^;]*'sha256-[^']+'/.test(policy) &&
        !/unsafe-eval|https?:|\*/.test(policy) &&
        !/script-src [^;]*('unsafe-inline'|'self')/.test(policy),
      policy,
    );
    const folder = `${pathToFileURL(path.dirname(viewerPath)).href}/`.toLowerCase();
    // A picture of the map and a download are no request to anywhere (`data:`, `blob:`), and
    // the exported page was opened by the run itself.
    const away = requests.filter(
      (url) =>
        !url.toLowerCase().startsWith(folder) &&
        !url.startsWith('data:') &&
        !url.startsWith('blob:') &&
        url !== exportedPage,
    );
    check(
      `every request of the run stayed in the folder of the viewer (${requests.length} requests)`,
      requests.length > 0 && away.length === 0,
      // An address may be a whole picture.
      away.slice(0, 5).map((url) => url.slice(0, 200)),
    );
    check(
      'nothing the viewer did during the run violated its policy',
      violations.length === 0,
      violations.slice(0, 5),
    );
    const probed = await client.send('Runtime.evaluate', {
      expression: POLICY_PROBE,
      returnByValue: true,
      awaitPromise: true,
      // Otherwise the protocol lets evaluated code make code from strings whatever the policy says.
      allowUnsafeEvalBlockedByCSP: false,
    });
    const blocked = probed.result?.value;
    check(
      'the policy stops code from strings, injected and local script files, and requests elsewhere',
      blocked &&
        blocked.evalRan === false &&
        blocked.inlineRan === false &&
        blocked.besideRan === false &&
        blocked.fetched === 'failed' &&
        ['connect-src', 'img-src'].every((name) => blocked.directives.includes(name)) &&
        blocked.directives.some((/** @type {string} */ name) => name.startsWith('script-src')),
      blocked ?? probed.exceptionDetails?.text,
    );
  } finally {
    if (scratch !== undefined)
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    // Ask the browser to quit (so that it lets go of its profile), then make sure it is gone.
    const exited = new Promise((resolve) => browser.once('exit', resolve));
    await cdp?.send('Browser.close').catch(() => undefined);
    await Promise.race([exited, sleep(3000)]);
    cdp?.close();
    if (browser.exitCode === null) {
      browser.kill();
      await Promise.race([exited, sleep(2000)]);
    }
    // The profile is in the temp directory. The shared one that cannot be removed is emptied and
    // used again by the next run; one of this run's own is worth a word (a later run tries
    // again). Neither fails the run.
    const removed = await Promise.race([removeProfile(profile), sleep(8000).then(() => false)]);
    if (profileLock !== undefined) await rm(profileLock, { force: true }).catch(() => undefined);
    else if (!removed) console.warn(`smoke: could not remove the browser profile ${profile}`);
  }
  return failures;
}

const viewerPath = path.resolve(process.argv[2] ?? 'dist/viewer.html');
const browserPath = BROWSERS.find((candidate) => candidate !== undefined && existsSync(candidate));
if (!existsSync(viewerPath)) {
  console.error(`smoke: ${viewerPath} not found — run "npm run build" first.`);
  process.exit(2);
}
if (browserPath === undefined) {
  console.error('smoke: no Edge or Chrome found — set BROWSER to the path of the executable.');
  process.exit(2);
}

try {
  const failures = await run(viewerPath, browserPath);
  if (failures.length > 0) {
    console.error(`smoke: ${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log('smoke: all checks passed.');
  // Explicitly: a lingering handle (socket, child process) must not keep the script alive.
  process.exit(0);
} catch (error) {
  console.error(`smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
