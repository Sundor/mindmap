// Work items: the types the map overlays on the structure, and the parser of the
// work-items data file (`fixtures/workitems.json`, format version 1). Pure: no React, no browser
// APIs. Nothing here throws; problems in the file become diagnostics.

import type { Diagnostic } from './diagnostics';
import { isWebUrl } from './text';

/** Work-item types shown on the map, from the coarsest to the finest. */
export const WORK_ITEM_TYPES = ['Epic', 'Feature', 'User Story', 'Bug', 'Task'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export function isWorkItemType(value: unknown): value is WorkItemType {
  return typeof value === 'string' && (WORK_ITEM_TYPES as readonly string[]).includes(value);
}

/** What the canvas shows of the work items: nothing, the top-level items, or their tasks too. */
export const STORY_MODES = ['off', 'stories', 'tasks'] as const;
export type StoryMode = (typeof STORY_MODES)[number];

/** The names of the modes, as the selector and the panel say them. */
export const STORY_MODE_LABELS: Readonly<Record<StoryMode, string>> = {
  off: 'Off',
  stories: 'Stories only',
  tasks: 'Stories + Tasks',
};

export function isStoryMode(value: unknown): value is StoryMode {
  return typeof value === 'string' && (STORY_MODES as readonly string[]).includes(value);
}

/** Extra parameters of a work item, e.g. Story Points, Priority, Area, Remaining Work. */
export type WorkItemFields = Readonly<Record<string, string | number>>;

/** One work item as the map uses it. */
export interface WorkItemSummary {
  readonly id: number;
  readonly type: WorkItemType;
  readonly title: string;
  readonly state: string;
  readonly assignedTo?: string;
  readonly iteration?: string;
  /** Link to the item in ADO; absent in data that has none (the mock data). */
  readonly url?: string;
  /** Node IDs from the `comp:` tags: prefix stripped, trimmed, lower-cased, no duplicates. */
  readonly componentIds: readonly string[];
  /** The other tags, trimmed, in the order of the file. */
  readonly tags: readonly string[];
  /** Parent item (a story for a task, a feature for a story, …). Always an item of the set. */
  readonly parentId?: number;
  readonly description?: string;
  readonly fields?: WorkItemFields;
}

/** Where work items come from. The one implementation reads the work-items data file. */
export interface WorkItemProvider {
  fetch(): Promise<WorkItemSummary[]>;
}

/** Version of the work-items data file this code reads. */
export const WORK_ITEMS_FILE_VERSION = 1;

/** Prefix of the tags that link a work item to a node: `comp:<node-id>`. */
export const COMPONENT_TAG_PREFIX = 'comp:';

export interface ParsedTags {
  /** IDs named by `comp:` tags, lower-cased, without duplicates, in the order of the string. */
  readonly componentIds: string[];
  /** Every other tag, trimmed, without empty entries, in the order of the string. */
  readonly tags: string[];
}

/**
 * Splits an ADO `System.Tags` string ("comp:storefront.web; risk") into the node IDs of its
 * `comp:` tags and the other tags. Entries are separated by ";" and trimmed; the prefix matches
 * in any letter case; IDs are lower-cased (node IDs are lowercase). A `comp:` tag without an ID
 * names nothing and is dropped.
 */
export function parseTags(tags: string | undefined): ParsedTags {
  const componentIds: string[] = [];
  const others: string[] = [];
  for (const raw of (tags ?? '').split(';')) {
    const tag = raw.trim();
    if (tag === '') continue;
    if (tag.slice(0, COMPONENT_TAG_PREFIX.length).toLowerCase() === COMPONENT_TAG_PREFIX) {
      const id = tag.slice(COMPONENT_TAG_PREFIX.length).trim().toLowerCase();
      if (id !== '' && !componentIds.includes(id)) componentIds.push(id);
    } else {
      others.push(tag);
    }
  }
  return { componentIds, tags: others };
}

export interface ParseWorkItemsOptions {
  /** File name put on every diagnostic. */
  readonly sourceName?: string;
}

export interface WorkItemsParseResult {
  /** The valid items, ordered by ID. */
  readonly items: WorkItemSummary[];
  readonly errors: Diagnostic[];
  readonly warnings: Diagnostic[];
}

const ITEM_KEYS = new Set([
  'id',
  'type',
  'title',
  'state',
  'assignedTo',
  'iteration',
  'tags',
  'parentId',
  'description',
  'url',
  'fields',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isItemId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Parses the text of a work-items data file:
 *
 *     { "version": 1, "items": [ { "id": 101, "type": "User Story", "title": "…", "state": "Active",
 *       "assignedTo"?, "iteration"?, "tags"? ("comp:storefront.web; risk"), "parentId"?,
 *       "description"?, "url"?, "fields"? { "Story Points": 5 } } ] }
 *
 * Never throws. Text that is not JSON, another version or a missing item list are errors and
 * give no items. Within the list a broken item (wrong shape, duplicate ID) is an error and an
 * item of a type the map does not show a warning; either is skipped and the rest still load.
 * A parent that is not in the file, or a chain of parents that runs in a circle, is reported and
 * the item is kept without that parent.
 */
export function parseWorkItems(
  jsonText: string,
  options: ParseWorkItemsOptions = {},
): WorkItemsParseResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const source = options.sourceName === undefined ? {} : { source: options.sourceName };
  const error = (path: string, message: string): void => {
    errors.push({ severity: 'error', path, message, ...source });
  };
  const warning = (path: string, message: string): void => {
    warnings.push({ severity: 'warning', path, message, ...source });
  };
  const failed = (): WorkItemsParseResult => ({ items: [], errors, warnings });

  let json: unknown;
  try {
    // A file saved as "UTF-8 with BOM" keeps the mark when it comes through workitems.data.js.
    json = JSON.parse(jsonText.replace(/^\uFEFF/, ''));
  } catch (err: unknown) {
    error('', `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return failed();
  }
  if (!isRecord(json)) {
    error('', 'The file must be an object with "version" and "items".');
    return failed();
  }
  if (json.version !== WORK_ITEMS_FILE_VERSION) {
    error(
      'version',
      `Unsupported version ${JSON.stringify(json.version) ?? 'undefined'}; expected ${WORK_ITEMS_FILE_VERSION}.`,
    );
    return failed();
  }
  if (!Array.isArray(json.items)) {
    error('items', '"items" must be a list of work items.');
    return failed();
  }

  const byId = new Map<number, WorkItemSummary>();
  /** Where each kept item is in the file, for the diagnostics about parents. */
  const pathOf = new Map<number, string>();
  const parentOf = new Map<number, number>();
  (json.items as unknown[]).forEach((raw, index) => {
    const path = `items[${index}]`;
    if (!isRecord(raw)) {
      error(path, 'A work item must be an object.');
      return;
    }
    const problems: string[] = [];
    const text = (key: string, required: boolean): string | undefined => {
      const value = raw[key];
      if (value === undefined || value === null) {
        if (required) problems.push(`"${key}" is required`);
        return undefined;
      }
      if (typeof value !== 'string') {
        problems.push(`"${key}" must be text`);
        return undefined;
      }
      const trimmed = value.trim();
      if (trimmed === '') {
        if (required) problems.push(`"${key}" must not be empty`);
        return undefined;
      }
      return trimmed;
    };

    const id = raw.id;
    if (!isItemId(id)) problems.push('"id" must be a positive whole number');
    const title = text('title', true);
    const state = text('state', true);
    const type = text('type', true);
    const assignedTo = text('assignedTo', false);
    const iteration = text('iteration', false);
    const tags = text('tags', false);
    const description = text('description', false);
    const url = text('url', false);
    const parentId = raw.parentId ?? undefined;
    if (parentId !== undefined && !isItemId(parentId)) {
      problems.push('"parentId" must be a positive whole number');
    }
    let fields: Record<string, string | number> | undefined;
    if (raw.fields !== undefined && raw.fields !== null) {
      if (!isRecord(raw.fields)) {
        problems.push('"fields" must be an object of texts and numbers');
      } else {
        const entries: [string, string | number][] = [];
        for (const [name, value] of Object.entries(raw.fields)) {
          if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
            entries.push([name, value]);
          } else {
            problems.push(`"fields.${name}" must be a text or a number`);
          }
        }
        // Not by assignment, which would lose a field named "__proto__".
        fields = Object.fromEntries(entries);
      }
    }
    if (problems.length > 0) {
      error(path, `Work item skipped: ${problems.join('; ')}.`);
      return;
    }
    if (!isItemId(id) || title === undefined || state === undefined || type === undefined) return;
    if (!isWorkItemType(type)) {
      warning(
        `${path}.type`,
        `Work item #${id} skipped: type "${type}" is not shown (${WORK_ITEM_TYPES.join(', ')}).`,
      );
      return;
    }
    if (byId.has(id)) {
      error(`${path}.id`, `Duplicate work item ID ${id}; the first one is kept.`);
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!ITEM_KEYS.has(key)) warning(`${path}.${key}`, `Unknown key "${key}" is ignored.`);
    }
    const link = url !== undefined && isWebUrl(url) ? url : undefined;
    if (url !== undefined && link === undefined) {
      warning(
        `${path}.url`,
        `Work item #${id}: "url" is not an http(s) address; the item is kept without its link.`,
      );
    }
    const parsedTags = parseTags(tags);
    byId.set(id, {
      id,
      type,
      title,
      state,
      ...(assignedTo !== undefined ? { assignedTo } : {}),
      ...(iteration !== undefined ? { iteration } : {}),
      ...(link !== undefined ? { url: link } : {}),
      componentIds: parsedTags.componentIds,
      tags: parsedTags.tags,
      ...(description !== undefined ? { description } : {}),
      ...(fields !== undefined && Object.keys(fields).length > 0 ? { fields } : {}),
    });
    pathOf.set(id, path);
    if (isItemId(parentId)) parentOf.set(id, parentId);
  });

  // Parents: one that is not in the file is dropped; so is every link of a circle of parents.
  for (const [id, parentId] of [...parentOf]) {
    if (byId.has(parentId)) continue;
    parentOf.delete(id);
    warning(
      `${pathOf.get(id) ?? ''}.parentId`,
      `Work item #${id} names parent #${parentId}, which is not in the file; the parent is ignored.`,
    );
  }
  const inCycle = new Set<number>();
  // Items whose way up has been walked already: every item is walked once, however long the
  // chains of the file are.
  const walked = new Set<number>();
  for (const start of parentOf.keys()) {
    const chain: number[] = [];
    const onChain = new Set<number>();
    let current: number | undefined = start;
    while (current !== undefined && !onChain.has(current) && !walked.has(current)) {
      chain.push(current);
      onChain.add(current);
      current = parentOf.get(current);
    }
    // The walk came back to an item of the chain: from there on it is a circle.
    if (current !== undefined && onChain.has(current))
      for (const id of chain.slice(chain.indexOf(current))) inCycle.add(id);
    for (const id of chain) walked.add(id);
  }
  for (const id of [...inCycle].sort((a, b) => a - b)) {
    error(
      `${pathOf.get(id) ?? ''}.parentId`,
      `Work item #${id} is its own ancestor (parent #${parentOf.get(id)}); the parent is ignored.`,
    );
    parentOf.delete(id);
  }

  const items = [...byId.values()]
    .map((item): WorkItemSummary => {
      const parentId = parentOf.get(item.id);
      return parentId === undefined ? item : { ...item, parentId };
    })
    .sort((a, b) => a.id - b.id);
  return { items, errors, warnings };
}
