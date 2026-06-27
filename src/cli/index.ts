#!/usr/bin/env node
import { buildProgram } from "./program.js";

// Exit quietly when a downstream pipe closes early (e.g. `plasalid ledger --json | head`).
const exitOnEpipe = (err: NodeJS.ErrnoException): void => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
};
process.stdout.on("error", exitOnEpipe);
process.stderr.on("error", exitOnEpipe);

buildProgram().parse();
