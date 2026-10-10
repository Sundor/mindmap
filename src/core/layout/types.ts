// Layout result types.

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Geometry of one row band, in canvas coordinates. Bands are stacked top → bottom, contiguous. */
export interface RowBand {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutResult {
  /** Hash of the layout-relevant structure (see `layoutKey`). */
  readonly key: string;
  /**
   * Node rectangles relative to the parent node (top-level nodes: relative to the canvas origin),
   * which is what React Flow child nodes need. Iterates in model (YAML document) order.
   */
  readonly rects: ReadonlyMap<string, Rect>;
  /** The same rectangles in canvas coordinates. */
  readonly absolute: ReadonlyMap<string, Rect>;
  /** Row bands, top → bottom; empty when the model has no rows. */
  readonly rows: readonly RowBand[];
  /** Width of the band label gutter at the left edge of the bands; 0 without rows. */
  readonly gutterWidth: number;
  /** Side area right of the bands for top-level nodes with no row anywhere in their subtree. */
  readonly unassignedArea?: Rect;
  /** Size of everything laid out, from the canvas origin. */
  readonly bounds: Size;
  /** Nodes whose row was derived from their connections (row-less children of spanning groups). */
  readonly placedRow: ReadonlyMap<string, string>;
  /**
   * Row each single-row node sits in: its effective row, or the row derived for it or an ancestor
   * by connection attraction. Spanning groups and unassigned nodes are absent.
   */
  readonly rowOf: ReadonlyMap<string, string>;
  /**
   * Where the content block of each node that has one lies (see `ComputeLayoutOptions.content`),
   * relative to the node: below the header of a group, below the name of a leaf, as wide as the
   * node. In model order; empty when the layout was computed without content.
   */
  readonly content: ReadonlyMap<string, Rect>;
  /**
   * The layout this one was made from by moving or resizing boxes by hand. Edge routes are
   * remembered for that base, keyed by the rectangles they depend on, so a hand move reroutes
   * only the edges it touches.
   */
  readonly routeBase?: LayoutResult;
}
