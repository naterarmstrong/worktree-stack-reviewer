import { initLog } from '../../src/log';

// The log channel is a module-level singleton the extension creates on
// activate, and every module under test writes to it. Without this the first
// git call fails with "log channel accessed before init".
initLog({ subscriptions: [] } as never);
