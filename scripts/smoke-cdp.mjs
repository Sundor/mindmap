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
  };
  true
`;

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
    scratch = await mkdtemp(path.join(os.tmpdir(), 'arch-map-smoke-data-'));
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
          list.top >= panel.top &&
          list.bottom <= panel.bottom &&
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
    const away = requests.filter(
      (url) => !url.toLowerCase().startsWith(folder) && !url.startsWith('data:'),
    );
    check(
      `every request of the run stayed in the folder of the viewer (${requests.length} requests)`,
      requests.length > 0 && away.length === 0,
      away.slice(0, 5),
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
