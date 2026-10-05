// React Flow typings of the plain objects produced by `buildFlow` (src/core/flow.ts).

import type { Edge, Node } from '@xyflow/react';
import type { ArchEdgeData, ArchNodeData, ArchNodeType, BandNodeData } from '../core';

export type ArchRFNode = Node<ArchNodeData, ArchNodeType>;
export type BandRFNode = Node<BandNodeData, 'band'>;
export type AppNode = ArchRFNode | BandRFNode;
export type AppEdge = Edge<ArchEdgeData, 'arch'>;
