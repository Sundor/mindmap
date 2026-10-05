// The version of the viewer: the `version` of package.json (README.md, "Versioning"). The build
// puts it in as text; where nothing does — the unit tests — it is 'dev'.

declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
