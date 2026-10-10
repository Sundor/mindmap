// What the pages are drawn from: a small model that holds one of everything, and the shipped
// example, each with its work items and the layouts and flows asked of it; and what React Flow's
// store is given so that a canvas is drawn without a browser.

import { Position, type ReactFlowState } from '@xyflow/react';
import exampleYaml from '../../examples/architecture.yaml?raw';
import exampleWorkItems from '../../fixtures/workitems.json?raw';
import {
  arrangedLayout,
  buildFlow,
  buildWorkItemOverlay,
  closedGroupSize,
  computeLayoutUncached,
  parseArchitecture,
  parseWorkItems,
  SIDES,
  sourceHandleId,
  targetHandleId,
  visibleNodes,
  workItemContent,
  type ArchitectureModel,
  type FlowGraph,
  type FlowNode,
  type FlowWorkItems,
  type LayoutResult,
  type LodLevel,
  type NodeContent,
  type ParseResult,
  type Side,
  type StoryMode,
  type Viewport,
  type WorkItemOverlay,
  type WorkItemsParseResult,
  type WorkItemSummary,
} from '../core';
import type { AppNode } from '../ui/flowTypes';

// --- The specimen model -----------------------------------------------------------------------

/**
 * A structure file that holds one of everything the map draws:
 * - three rows; `desk` and `billing` with a row of their own, `routing` spanning two rows with a
 *   component (`routing.notifier`) placed by its connections, `tools` with no row anywhere (the
 *   Unassigned area);
 * - leaves of all three levels, a component with three children, and one (`routing.planner`)
 *   with five children with long names: closed and shrunk, its box lists them above the line of
 *   its badge;
 * - owner, status and tech (inherited and overridden), metrics, links, a description of several
 *   lines;
 * - edges of all four kinds with label and protocol, one with a description, two that become one
 *   aggregate when `desk.portal` and `routing.planner` are closed, edges inside a component;
 * - a workflow and a data flow.
 */
export const SPECIMEN_YAML = `version: 1

rows:
  - id: front
    name: Front office
    description: What customers and staff work with
  - id: services
    name: Services
    description: Planning and accounting
  - id: storage
    name: Storage

domains:
  - id: desk
    name: Service Desk
    description: |
      Where a delivery is booked and followed.
      Customers use the portal; staff answer in the chat what the portal cannot.
    row: front
    owner: Desk team
    status: live
    tech: TypeScript
    components:
      - id: desk.portal
        name: Customer Portal
        description: Booking and tracking for customers
        links:
          - label: Source
            url: https://example.com/git/customer-portal
          - label: User guide
            url: https://example.com/docs/portal
        metrics:
          loc: 48000
          churn: 31
        subcomponents:
          - id: desk.portal.booking
            name: Booking Form
            description: Takes a delivery request and the payment for it
          - id: desk.portal.tracking
            name: Tracking Page
          - id: desk.portal.account
            name: Account
            status: planned
      - id: desk.chat
        name: Chat
        description: Staff answer customers here
        owner: Support team
        metrics:
          loc: 9000
          churn: 4

  - id: billing
    name: Billing
    description: Invoices and tariffs
    row: front
    owner: Finance team
    status: deprecated
    links:
      - label: Runbook
        url: https://example.com/docs/billing-runbook

  - id: routing
    name: Routing
    description: Plans the tours and tells everyone about them
    owner: Logistics team
    tech: Kotlin
    components:
      - id: routing.planner
        name: Tour Planner
        description: Turns the requests of a day into tours
        row: services
        status: live
        metrics:
          loc: 120000
          churn: 64
        subcomponents:
          - id: routing.planner.addresses
            name: Address Normalisation
          - id: routing.planner.traffic
            name: Traffic Forecast
          - id: routing.planner.windows
            name: Delivery Windows
          - id: routing.planner.capacity
            name: Vehicle Capacity
          - id: routing.planner.exceptions
            name: Exceptions and Re-routing
      - id: routing.archive
        name: Tour Archive
        description: Every finished tour, kept for seven years
        row: storage
        tech: PostgreSQL
        metrics:
          loc: 14000
          churn: 2
      - id: routing.notifier
        name: Notifier
        description: Sends the notices of a tour to whoever follows it

  - id: tools
    name: Shared Tools
    description: Used by every team and part of no level
    components:
      - id: tools.logging
        name: Logging
      - id: tools.metrics
        name: Metrics

edges:
  - id: booking-request
    from: desk.portal.booking
    to: routing.planner.addresses
    kind: dataflow
    label: delivery request
    protocol: REST
    description: Sent as soon as the booking is paid
  - id: window-query
    from: desk.portal.tracking
    to: routing.planner.windows
    kind: dataflow
    label: delivery window
    protocol: REST
  - id: booking-account
    from: desk.portal.booking
    to: desk.portal.account
    kind: dependency
    label: prefills from
  - id: addresses-to-windows
    from: routing.planner.addresses
    to: routing.planner.windows
    kind: dataflow
    label: clean addresses
  - id: traffic-to-windows
    from: routing.planner.traffic
    to: routing.planner.windows
    kind: dataflow
    label: travel times
  - id: windows-to-capacity
    from: routing.planner.windows
    to: routing.planner.capacity
    kind: dataflow
    label: time slots
  - id: windows-to-exceptions
    from: routing.planner.windows
    to: routing.planner.exceptions
    kind: control
    label: missed window
  - id: tours-archived
    from: routing.planner
    to: routing.archive
    kind: dataflow
    label: finished tours
    protocol: SQL
  - id: notice-order
    from: routing.planner.exceptions
    to: routing.notifier
    kind: control
    label: send notice
    protocol: gRPC
  - id: status-updates
    from: routing.notifier
    to: desk.portal.tracking
    kind: dataflow
    label: status updates
    protocol: Webhook
  - id: invoice-lookup
    from: desk.chat
    to: billing
    kind: dependency
    label: invoice lookup
    protocol: SQL
  - id: tariffs
    from: billing
    to: routing.planner
    kind: config
    label: tariffs
    protocol: JSON

flows:
  - id: book-a-delivery
    name: Book a delivery
    kind: workflow
    description: >-
      From the booking form to the notice on the tracking page: the address is cleaned, the
      request gets a window, and the customer is told when the window is missed.
    edges:
      - booking-request
      - addresses-to-windows
      - windows-to-exceptions
      - notice-order
      - status-updates
  - id: tour-records
    name: Tour records
    kind: dataflow
    description: Where the data of a finished tour ends up.
    nodes:
      - billing
    edges:
      - tours-archived
      - tariffs
`;

const SPRINT_7 = 'Parcel\\Sprint 7';
const SPRINT_8 = 'Parcel\\Sprint 8';

/**
 * A work-items file for {@link SPECIMEN_YAML}: an epic and two features, stories in every state,
 * three bugs of which two are open, eleven stories and bugs on the leaf `billing` (more than a
 * box lists), two stories with tasks, one of them with a link, on two nodes and with a tag that
 * names no node, one story without a tag, two iterations.
 */
export const SPECIMEN_WORK_ITEMS = JSON.stringify(
  {
    version: 1,
    items: [
      {
        id: 100,
        type: 'Epic',
        title: 'Same-day delivery',
        state: 'Active',
        assignedTo: 'Alex Morgan',
        tags: 'comp:routing; programme',
        description: 'Everything needed to offer delivery on the day of the booking.',
        fields: { Priority: 1, 'Target Date': '2026-11-27' },
      },
      {
        id: 101,
        type: 'Feature',
        title: 'Live tracking',
        state: 'Active',
        assignedTo: 'Sam Rivera',
        tags: 'comp:desk.portal',
        parentId: 100,
        description: 'Customers see where their parcel is without asking.',
        fields: { Priority: 2, 'Business Value': 80 },
      },
      {
        id: 102,
        type: 'Feature',
        title: 'Tours that adapt to traffic',
        state: 'New',
        assignedTo: 'Jamie Chen',
        tags: 'comp:routing.planner',
        parentId: 100,
        fields: { Priority: 2, 'Business Value': 60 },
      },
      {
        id: 110,
        type: 'User Story',
        title: 'Pay for a booking with a saved card',
        state: 'Active',
        assignedTo: 'Robin Patel',
        iteration: SPRINT_7,
        url: 'https://example.com/work/110',
        tags: 'comp:desk.portal.booking; comp:desk.portal.account; comp:desk.fax; payments',
        parentId: 101,
        description:
          'A returning customer pays with the card kept in the account. The card is asked for again when it has expired.',
        fields: { 'Story Points': 5, Priority: 1 },
      },
      {
        id: 111,
        type: 'Task',
        title: 'Read the saved cards from the account',
        state: 'Closed',
        assignedTo: 'Robin Patel',
        iteration: SPRINT_7,
        parentId: 110,
        fields: { 'Remaining Work': 0 },
      },
      {
        id: 112,
        type: 'Task',
        title: 'Ask again for an expired card',
        state: 'Active',
        assignedTo: 'Robin Patel',
        iteration: SPRINT_7,
        parentId: 110,
        fields: { 'Remaining Work': 6 },
      },
      {
        id: 113,
        type: 'User Story',
        title: 'Show the delivery window on the tracking page',
        state: 'New',
        assignedTo: 'Sam Rivera',
        iteration: SPRINT_8,
        tags: 'comp:desk.portal.tracking',
        parentId: 101,
        fields: { 'Story Points': 3 },
      },
      {
        id: 114,
        type: 'Task',
        title: 'Query the window when the page opens',
        state: 'New',
        iteration: SPRINT_8,
        parentId: 113,
      },
      {
        id: 115,
        type: 'Bug',
        title: 'Tracking page shows yesterday after midnight',
        state: 'Active',
        assignedTo: 'Sam Rivera',
        iteration: SPRINT_7,
        tags: 'comp:desk.portal.tracking',
        fields: { Severity: '2 - High' },
      },
      {
        id: 120,
        type: 'User Story',
        title: 'Send the invoice as a PDF',
        state: 'Closed',
        iteration: SPRINT_7,
        tags: 'comp:billing',
      },
      {
        id: 121,
        type: 'User Story',
        title: 'Put the tour number on the invoice',
        state: 'Resolved',
        iteration: SPRINT_7,
        tags: 'comp:billing',
      },
      {
        id: 122,
        type: 'User Story',
        title: 'Charge a late cancellation',
        state: 'Active',
        iteration: SPRINT_7,
        tags: 'comp:billing',
      },
      {
        id: 123,
        type: 'Bug',
        title: 'Invoice total rounds the wrong way',
        state: 'New',
        iteration: SPRINT_7,
        tags: 'comp:billing',
      },
      {
        id: 124,
        type: 'Bug',
        title: 'Holiday tariff applied a day late',
        state: 'Closed',
        iteration: SPRINT_7,
        tags: 'comp:billing',
      },
      {
        id: 125,
        type: 'User Story',
        title: 'Remind after fourteen days',
        state: 'New',
        iteration: SPRINT_8,
        tags: 'comp:billing',
      },
      {
        id: 126,
        type: 'User Story',
        title: 'Pay by direct debit',
        state: 'New',
        iteration: SPRINT_8,
        tags: 'comp:billing',
      },
      {
        id: 127,
        type: 'User Story',
        title: 'Credit note for a lost parcel',
        state: 'New',
        iteration: SPRINT_8,
        tags: 'comp:billing',
      },
      {
        id: 128,
        type: 'User Story',
        title: 'Monthly statement for business customers',
        state: 'New',
        iteration: SPRINT_8,
        tags: 'comp:billing',
      },
      {
        id: 129,
        type: 'User Story',
        title: 'Export the invoices for the tax advisor',
        state: 'New',
        tags: 'comp:billing',
      },
      {
        id: 130,
        type: 'User Story',
        title: 'Tariff by weight and distance',
        state: 'New',
        tags: 'comp:billing',
      },
      {
        id: 140,
        type: 'User Story',
        title: 'Take the traffic forecast into the window',
        state: 'Active',
        assignedTo: 'Jamie Chen',
        iteration: SPRINT_8,
        tags: 'comp:routing.planner.windows',
        parentId: 102,
        fields: { 'Story Points': 8 },
      },
      {
        id: 141,
        type: 'User Story',
        title: 'Keep the signature with the archived tour',
        state: 'Active',
        iteration: SPRINT_8,
        tags: 'comp:routing.archive',
      },
      {
        id: 142,
        type: 'User Story',
        title: 'Agree on the wording of the notices',
        state: 'New',
        assignedTo: 'Alex Morgan',
      },
      {
        id: 143,
        type: 'User Story',
        title: 'Hand a chat over to a colleague',
        state: 'Resolved',
        iteration: SPRINT_7,
        tags: 'comp:desk.chat',
      },
    ],
  },
  null,
  2,
);

// --- Model, work items, layouts and flows -----------------------------------------------------

/** What of a map is drawn, as the Detail and Layout tabs choose it. */
import { allResizeLimits, NO_HAND_OVERRIDES } from '../core';

export interface FixtureView {
  readonly mode: StoryMode;
  readonly lod: LodLevel;
  /** Groups collapsed by hand. */
  readonly collapsed?: readonly string[];
  /** Closed groups drawn shrunk. */
  readonly compact?: boolean;
  /** Positions unlocked: the boxes can be dragged. */
  readonly draggable?: boolean;
  /** The map closed up around what is drawn, which also draws closed groups shrunk. */
  readonly closeGaps?: boolean;
  /**
   * Whether the layout keeps room for the work-item lists. Left out: at the Everything level
   * only, as in the app once the view rests. The app keeps the room for a moment after the level
   * became coarser and has none yet for a moment after it became Everything: `true` at a coarser
   * level draws the badges where the lists were, `false` at Everything draws them on the corners
   * of the boxes.
   */
  readonly lines?: boolean;
}

export interface MapFixture {
  readonly model: ArchitectureModel;
  readonly parsed: ParseResult;
  /** What reading the work-items file gave, with its errors and warnings. */
  readonly work: WorkItemsParseResult;
  readonly items: readonly WorkItemSummary[];
  /** The unfiltered overlay of `items` on `model`. */
  readonly overlay: WorkItemOverlay;
  /** Layout and flow for a story mode and view; computed once each and kept. */
  flow(view: FixtureView): Promise<{ layout: LayoutResult; flow: FlowGraph }>;
}

export interface Fixtures {
  /** {@link SPECIMEN_YAML} with {@link SPECIMEN_WORK_ITEMS}. */
  readonly specimen: MapFixture;
  /** The shipped example with the shipped work items. */
  readonly example: MapFixture;
}

interface Reference {
  readonly content: ReadonlyMap<string, NodeContent>;
  readonly layout: LayoutResult;
}

/** The fixture of one structure file and one work-items file. Throws when the structure has errors. */
function mapFixture(yaml: string, workItems: string): MapFixture {
  const parsed = parseArchitecture(yaml, { sourceName: 'architecture.yaml' });
  const { model } = parsed;
  if (!model) {
    const [first] = parsed.errors;
    throw new Error(`The structure does not parse: ${first?.path ?? ''} ${first?.message ?? ''}`);
  }
  const work = parseWorkItems(workItems, { sourceName: 'workitems.json' });
  const overlay = buildWorkItemOverlay(model, work.items);
  const references = new Map<StoryMode, Promise<Reference>>();
  const flows = new Map<string, Promise<{ layout: LayoutResult; flow: FlowGraph }>>();

  // One layout per content, as in the app: of the whole map, whatever of it is drawn.
  const reference = (contentMode: StoryMode): Promise<Reference> => {
    let kept = references.get(contentMode);
    if (!kept) {
      const content = workItemContent(overlay, contentMode);
      kept = computeLayoutUncached(model, undefined, content).then((layout) => ({
        content,
        layout,
      }));
      references.set(contentMode, kept);
    }
    return kept;
  };

  const build = async (view: FixtureView): Promise<{ layout: LayoutResult; flow: FlowGraph }> => {
    const lines = view.lines ?? view.lod === 'detail';
    const { content, layout: whole } = await reference(lines ? view.mode : 'off');
    const collapsedIds = new Set(view.collapsed);
    const workItems: FlowWorkItems = { overlay, mode: view.mode };
    const closeGaps = view.closeGaps === true;
    const layout = closeGaps
      ? arrangedLayout(model, whole, {
          visible: visibleNodes(model, collapsedIds, view.lod),
          closedSize: (node, full) =>
            closedGroupSize(model, node, full, { compactCollapsed: true, workItems }),
          content,
        })
      : whole;
    const flow = buildFlow(model, layout, {
      collapsedIds,
      lodLevel: view.lod,
      compactCollapsed: view.compact === true || closeGaps,
      draggable: view.draggable === true,
      // Unlocked, the open groups get their resize handles with the limits the core gives.
      resize:
        view.draggable === true
          ? { limits: allResizeLimits(model, layout, NO_HAND_OVERRIDES), resized: new Set() }
          : undefined,
      workItems,
    });
    return { layout, flow };
  };

  return {
    model,
    parsed,
    work,
    items: work.items,
    overlay,
    flow(view) {
      const key = JSON.stringify([
        view.mode,
        view.lod,
        [...(view.collapsed ?? [])].sort(),
        view.compact === true,
        view.draggable === true,
        view.closeGaps === true,
        view.lines ?? view.lod === 'detail',
      ]);
      let kept = flows.get(key);
      if (!kept) {
        kept = build(view);
        flows.set(key, kept);
      }
      return kept;
    },
  };
}

/** The two maps the pages draw. Nothing is laid out until a flow is asked for. */
export function loadFixtures(): Promise<Fixtures> {
  return Promise.resolve().then(() => ({
    specimen: mapFixture(SPECIMEN_YAML, SPECIMEN_WORK_ITEMS),
    example: mapFixture(exampleYaml, exampleWorkItems),
  }));
}

// --- React Flow's store -----------------------------------------------------------------------

/**
 * Side of the square a handle is given, in pixels. In the viewer a handle is an element of
 * 1 × 1 px centred on the middle of its side (`.arch-handle` in styles.css), and React Flow ends
 * an edge at the outer edge of that element: half a pixel outside the box. 1 repeats that; with
 * 0 the edges would end exactly on the sides, where the curve of src/core ends.
 */
export const HANDLE_BOX = 1;

const POSITION: Readonly<Record<Side, Position>> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

/**
 * `node` with the handles its edges attach to: a source and a target centred on the middle of
 * each side, which React Flow otherwise measures in the page. A row band has none.
 */
export function withSideHandles(node: FlowNode): AppNode {
  if (node.type === 'band') return node;
  const { width, height } = node;
  const middle: Readonly<Record<Side, readonly [x: number, y: number]>> = {
    top: [width / 2, 0],
    right: [width, height / 2],
    bottom: [width / 2, height],
    left: [0, height / 2],
  };
  const handles = SIDES.flatMap((side) => {
    const [x, y] = middle[side];
    const box = {
      position: POSITION[side],
      x: x - HANDLE_BOX / 2,
      y: y - HANDLE_BOX / 2,
      width: HANDLE_BOX,
      height: HANDLE_BOX,
    };
    return [
      { ...box, id: sourceHandleId(side), type: 'source' as const },
      { ...box, id: targetHandleId(side), type: 'target' as const },
    ];
  });
  return { ...node, handles };
}

/** What of React Flow's store {@link storeSettings} sets. */
export type StoreSettings = Pick<
  ReactFlowState,
  | 'elementsSelectable'
  | 'nodesFocusable'
  | 'edgesFocusable'
  | 'nodesDraggable'
  | 'nodesConnectable'
  | 'edgesReconnectable'
  | 'elevateNodesOnSelect'
  | 'elevateEdgesOnSelect'
  | 'transform'
>;

/**
 * What MapCanvas gives `<ReactFlow>` as `elementsSelectable`, `nodesFocusable`, `edgesFocusable`,
 * `nodesDraggable` (its `positionsUnlocked`), `nodesConnectable`, `edgesReconnectable`,
 * `elevateNodesOnSelect` and `elevateEdgesOnSelect`, which React Flow copies into its store in
 * an effect; and the view, which the app sets by its own fit.
 */
export function storeSettings(unlocked: boolean, view: Viewport): StoreSettings {
  return {
    elementsSelectable: false,
    nodesFocusable: false,
    edgesFocusable: false,
    nodesDraggable: unlocked,
    nodesConnectable: false,
    edgesReconnectable: false,
    elevateNodesOnSelect: false,
    elevateEdgesOnSelect: false,
    transform: [view.x, view.y, view.zoom],
  };
}
