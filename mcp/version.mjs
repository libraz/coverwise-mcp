/**
 * Package version, read from `package.json` at runtime.
 *
 * The CLI banner and the MCP handshake both report a version; deriving both
 * from the manifest keeps a release bump to a single edit and makes drift
 * between them impossible.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** @type {string} */
export const PACKAGE_VERSION = require('../package.json').version;
