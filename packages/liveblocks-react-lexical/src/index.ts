import { detectDupes } from "@liveblocks/core";

import { PKG_FORMAT, PKG_NAME, PKG_VERSION } from "./version";

detectDupes(PKG_NAME, PKG_VERSION, PKG_FORMAT);

export { INSERT_THREAD_COMMAND } from "./CommentPluginProvider";
export { LexicalThread } from "./LexicalThread";
export { LiveblocksPlugin } from "./LiveblocksPlugin";
export * from "./TextCollaborationProvider";
export { liveblocksLexicalConfig } from "./utils";