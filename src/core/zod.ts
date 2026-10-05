// The one place zod is imported from at run time.
//
// Where the environment allows it, zod turns object schemas into functions built from strings
// (`new Function`). The viewer runs under a Content Security Policy that forbids making code
// from strings, and even zod's probe for it would
// be reported there as a violation. So that path is switched off for good: the browser and the
// tests then run the same code.

import { z } from 'zod';

z.config({ jitless: true });

export { z };
