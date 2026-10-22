// The level of detail in words: the names of its modes, what each shows, and the tooltip of the
// level-of-detail button on the rail of the control panel (ControlPanel).

import { lodModeAfter, type LodConfig, type LodMode } from '../core';

/** The modes of the level of detail by name. */
export const LOD_LABELS: Readonly<Record<LodMode, string>> = {
  auto: 'Auto',
  domains: 'Domains',
  components: 'Components',
  subcomponents: 'Subcomponents',
  detail: 'Everything',
};

function percent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** What a mode of the level of detail shows. */
export function lodModeHint(mode: LodMode, config: LodConfig): string {
  switch (mode) {
    case 'auto':
      return `Follows the zoom: domains below ${percent(config.componentsZoom)}, components up to ${percent(config.subcomponentsZoom)}, subcomponents up to ${percent(config.detailZoom)}, everything beyond (the thresholds are on the Map tab).`;
    case 'domains':
      return 'Domains only, with the edges merged between domains.';
    case 'components':
      return 'Components; subcomponents stay hidden.';
    case 'subcomponents':
      return 'Subcomponents; what is inside the boxes (work items) stays hidden.';
    case 'detail':
      return 'Everything, including what is inside the boxes (work items).';
  }
}

/**
 * The tooltip of the level-of-detail button on the rail: the mode in force and what it shows,
 * the level drawn (and the one to come once the view rests), and what a click does.
 */
export function lodButtonHint(
  mode: LodMode,
  config: LodConfig,
  drawn: string,
  pending: string | undefined,
): string {
  const state =
    mode === 'auto'
      ? pending === undefined
        ? `${drawn} drawn`
        : `${drawn} drawn, ${pending} once the view rests`
      : `pinned to ${LOD_LABELS[mode]}`;
  const next = lodModeAfter(mode);
  const click = next === 'auto' ? 'follow the zoom' : `pin ${LOD_LABELS[next]}`;
  return `Level of detail: ${LOD_LABELS[mode]} — ${state}. ${lodModeHint(mode, config)} Click: ${click}.`;
}
