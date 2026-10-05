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
      // The detail panel scrolls; the canvas must not be scrolled by this.
      if (el.closest('.detail-body')) el.scrollIntoView({ block: 'nearest' });
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
    nodesOnCanvas: () => {
      const c = document.querySelector('.react-flow').getBoundingClientRect();
      return [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-band)')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top;
      }).length;
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
      '--window-size=1500,950',
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
    /** @param {string} selector */
    const click = async (selector) => {
      await settled();
      const point = await until(
        `window.__smoke.clickPoint(${JSON.stringify(selector)})`,
        `a clickable ${selector}`,
      );
      await clickAt(point, selector);
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
     * Drops files on the page, as from the file manager. The pointer is parked in the gutter
     * afterwards, so that it rests on nothing of the map.
     * @param {string[]} files
     */
    const dropFiles = async (files) => {
      const data = { items: [], files, dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await client.send('Input.dispatchDragEvent', { type, x: 700, y: 500, data });
      }
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 500 });
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
    // The version (README.md, "Versioning"): the one of package.json, in the
    // toolbar and in the page itself.
    const packageVersion = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ).version;
    const shownVersion = await evaluate(`({
      toolbar: document.querySelector('#app-version')?.textContent ?? null,
      root: document.querySelector('.app')?.dataset.version ?? null,
      page: document.querySelector('meta[name="generator"]')?.content ?? null,
    })`);
    check(
      `the viewer shows its version, ${packageVersion}, and the page names it`,
      /^\d+\.\d+\.\d+/.test(packageVersion) &&
        shownVersion.toolbar === packageVersion &&
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
      'the toolbar names the work-items file',
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
    await press('/', { code: 'Slash', keyCode: 191, text: '/' });
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
    await press('/', { code: 'Slash', keyCode: 191, text: '/' });
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
    await press('/', { code: 'Slash', keyCode: 191, text: '/' });
    await client.send('Input.insertText', { text: 'event archives' });
    await click('#search-results [data-workitem-id="1035"]');
    await untilSelection('workitem:1035');
    check('search finds a story by words of its title', true);
    const filterCount = () => text('#workitem-filter-count');
    await evaluate(`document.querySelector('#settings').open = true`);
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
      'panel does not cover the toolbar',
      await evaluate(
        `document.querySelector('#detail-panel').getBoundingClientRect().top >= document.querySelector('.toolbar').getBoundingClientRect().bottom - 1`,
      ),
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
    // The pointer rests where the last click was; a result list opening under it would take the
    // highlight (hover). Park it in the row gutter first.
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 500 });
    await press('/', { code: 'Slash', keyCode: 191, text: '/' });
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

    await press('k', { code: 'KeyK', keyCode: 75, modifiers: 2 });
    check(
      'Ctrl+K focuses the search box',
      (await evaluate(`document.activeElement?.id`)) === 'search-input',
    );
    await client.send('Input.insertText', { text: 'event store' });
    await click('#search-results [data-node-id="data.event-store"]');
    await untilSelection('node:data.event-store');
    check('a search result can be chosen with the mouse', true);

    // --- Node panel links ---------------------------------------------------------------------
    await press('/', { code: 'Slash', keyCode: 191, text: '/' });
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

    // --- Settings: shrunk collapsed groups, adjustable thresholds ------------------------------
    const domainWidths = () =>
      evaluate(
        `[...document.querySelectorAll('.react-flow__node-group')].map((n) => n.offsetWidth)`,
      );
    /** @type {number[]} */
    const fullWidths = await domainWidths();
    await evaluate(`document.querySelector('#settings').open = true`);
    await sleep(100);
    check(
      'the settings drop-down opens inside the window',
      (await evaluate(`(() => {
        const r = document.querySelector('#settings .settings-body').getBoundingClientRect();
        return r.width > 0 && r.left >= 0 && r.right <= document.documentElement.clientWidth;
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
        const input = document.querySelector('#settings input[data-threshold="${key}"]');
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
    await evaluate(`document.querySelector('#settings').open = false`);
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
    await evaluate(`document.querySelector('#settings').open = true`);
    await sleep(100);
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
    await evaluate(`document.querySelector('#settings').open = false`);
    // The Everything threshold at the top of its slider: no zoom reaches the level, so going to
    // a work item in Auto pins Everything, or its line would not be drawn.
    await setThreshold('detailZoom', 4);
    await evaluate(`document.querySelector('#settings').open = false`);
    await press('/', { code: 'Slash', keyCode: 191, text: '/' });
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
    await evaluate(`document.querySelector('#settings').open = false`);
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
    // The toolbar wraps on a narrow window; the results list must stay inside the window.
    /** @type {string[]} */
    const cutOff = [];
    for (const width of [1280, 1024, 900, 800, 520]) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 700,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(300);
      await press('/', { code: 'Slash', keyCode: 191, text: '/' });
      await client.send('Input.insertText', { text: 'a' });
      await until(`window.__smoke.count('#search-results [role="option"]') > 0`, 'search results');
      await sleep(100);
      const span = await evaluate(
        `(() => { const r = document.querySelector('#search-results').getBoundingClientRect();
          return [r.left, r.right, document.documentElement.clientWidth].join(' '); })()`,
      );
      const [left = NaN, right = NaN, viewport = NaN] = String(span).split(' ').map(Number);
      if (!(left >= 0 && right <= viewport)) cutOff.push(`${width}: ${left}..${right}`);
      await press('Escape', { code: 'Escape', keyCode: 27 });
      await press('Escape', { code: 'Escape', keyCode: 27 });
    }
    check('the search results stay inside the window', cutOff.length === 0, cutOff.join('; '));

    // --- Long edges on a small window ---------------------------------------------------------
    // When both ends do not fit at the zoom that draws them, the source is the end shown.
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1100,
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
      await press('/', { code: 'Slash', keyCode: 191, text: '/' });
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

    // --- Lenses, focus, saved views, hints ------------------------------------
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await click('#expand-all');
    await until(`window.__smoke.attr('data-collapsed-count') === '0'`, 'everything expanded');
    await pinLod('components');
    await click('#fit-view');
    await sleep(600);
    const setSetting = async (/** @type {string} */ id, /** @type {boolean} */ on) => {
      await evaluate(`document.querySelector('#settings').open = true`);
      const checked = await evaluate(`document.querySelector('#${id}').checked`);
      if (checked !== on) await evaluate(`document.querySelector('#${id}').click()`);
      await evaluate(`document.querySelector('#settings').open = false`);
      await sleep(250);
    };
    const chooseOption = async (/** @type {string} */ selector, /** @type {string} */ value) => {
      await evaluate(`(() => {
        const select = document.querySelector(${JSON.stringify(selector)});
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(select, ${JSON.stringify(value)});
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
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
    // Showing the epic raised the pinned level to Everything: back to closed component boxes.
    await pinLod('components');
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
    await evaluate(`document.querySelector('#settings').open = true`);
    await chooseOption('#color-by', 'owner');
    await evaluate(`document.querySelector('#settings').open = false`);
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
    await evaluate(`document.querySelector('#settings').open = true`);
    await chooseOption('#color-by', 'metric:churn');
    await evaluate(`document.querySelector('#settings').open = false`);
    await until(`window.__smoke.attr('data-color-by') === 'metric:churn'`, 'colour by churn');
    check(
      'colour by a metric shows the range of the ramp and tints only the nodes that have it',
      (await text('#color-legend')).includes('73') &&
        (await countOf('#color-legend .color-legend-gradient')) === 1 &&
        (await countOf('.react-flow__node[data-id="data.event-store"] .arch-tinted')) === 0 &&
        (await countOf('.react-flow__node[data-id="backoffice.studio"] .arch-tinted')) === 1,
    );
    await evaluate(`document.querySelector('#settings').open = true`);
    await chooseOption('#color-by', 'none');
    await evaluate(`document.querySelector('#settings').open = false`);
    await until(`window.__smoke.attr('data-color-by') === 'none'`, 'colour by nothing');
    check('colour by nothing tints nothing', (await countOf('.arch-tinted')) === 0);
    // Edges on demand at the coarse levels.
    await setSetting('edges-on-demand', true);
    await until(`window.__smoke.attr('data-edges-quiet') === 'true'`, 'edges on demand');
    // The pointer rests on the last box clicked, whose edges would stay: park it in the gutter.
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 500 });
    await sleep(300);
    const edgesAll = await countOf('.react-flow__edge');
    check(
      'edges on demand hides every edge at the Components level while nothing is selected',
      edgesAll > 0 && (await countOf('.react-flow__edge.arch-quiet')) === edgesAll,
    );
    await click('.react-flow__node[data-id="data.event-store"]');
    await untilSelection('node:data.event-store');
    await sleep(200);
    const loud = await evaluate(
      `[...document.querySelectorAll('.react-flow__edge:not(.arch-quiet)')].map((e) => e.dataset.id)`,
    );
    check(
      'the selected box brings its own edges back',
      loud.length > 0 && loud.every((/** @type {string} */ id) => id.includes('data.event-store')),
      loud,
    );
    await press('Escape', { keyCode: 27 });
    await untilSelection(null);
    await pinLod('subcomponents');
    check(
      'at the finer levels every edge is drawn again',
      (await evaluate(`window.__smoke.attr('data-edges-quiet')`)) === 'false' &&
        (await countOf('.react-flow__edge.arch-quiet')) === 0,
    );
    await setSetting('edges-on-demand', false);
    await pinLod('components');
    // Saved views: save, change the map, come back; a link carries the view.
    await evaluate(`document.querySelector('#views').open = true`);
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
    await evaluate(`document.querySelector('#views').open = false`);
    await click('#collapse-all');
    await until(`Number(window.__smoke.attr('data-collapsed-count')) > 0`, 'groups collapsed');
    await pinLod('subcomponents');
    await evaluate(`document.querySelector('#views').open = true`);
    await evaluate(`document.querySelector('#views-list .views-apply').click()`);
    await evaluate(`document.querySelector('#views').open = false`);
    await until(`window.__smoke.attr('data-collapsed-count') === '0'`, 'the view applied');
    await until(`window.__smoke.attr('data-lod-mode') === 'components'`, 'its level of detail');
    check(
      'a saved view brings back the collapsed groups and the level of detail',
      (await evaluate(`window.__smoke.attr('data-lod-mode')`)) === 'components',
    );
    await evaluate(`document.querySelector('#views').open = true`);
    await evaluate(`document.querySelector('#views-list .views-delete').click()`);
    await until(`window.__smoke.count('#views-list li') === 0`, 'the view deleted');
    await evaluate(`document.querySelector('#views').open = false`);
    // The link: collapse again, reload with the fragment, and the view is back. (A navigation
    // that only changes the fragment is no reload: the page is reloaded explicitly.)
    const reloadWith = async (/** @type {string} */ hash) => {
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
    await press('/', { code: 'Slash', keyCode: 191, text: '/' });
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
    await evaluate(`document.querySelector('#settings').open = true`);
    const stateBoxes = await evaluate(
      `[...document.querySelectorAll('[data-workitem-state]')].map((e) => e.dataset.workitemState)`,
    );
    await evaluate(`document.querySelector('#settings').open = false`);
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
    await evaluate(`document.querySelector('#recent').open = true`);
    await sleep(100);
    check(
      'the recent drop-down opens inside the window',
      (await evaluate(`(() => {
        const r = document.querySelector('#recent .settings-body').getBoundingClientRect();
        return r.width > 0 && r.left >= 0 && r.right <= document.documentElement.clientWidth;
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
    await evaluate(`document.querySelector('#recent').open = false`);

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
